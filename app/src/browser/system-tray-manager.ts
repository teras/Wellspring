import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme } from 'electron';
import { localized } from '../intl';
import { waitForStatusNotifierHost } from './sni-host';
import Application from './application';

const _qdbusCache: { binary: string | null | undefined } = { binary: undefined };
function _findQdbus(): string | null {
  if (_qdbusCache.binary !== undefined) return _qdbusCache.binary;
  for (const binary of ['qdbus6', 'qdbus-qt6', 'qdbus', 'qdbus-qt5']) {
    const r = spawnSync('which', [binary], { encoding: 'utf8' });
    if (r.status === 0) {
      _qdbusCache.binary = binary;
      return binary;
    }
  }
  _qdbusCache.binary = null;
  return null;
}

function _isKDEWayland(): boolean {
  return (
    process.platform === 'linux' &&
    process.env.XDG_SESSION_TYPE === 'wayland' &&
    /KDE|plasma/i.test(process.env.XDG_CURRENT_DESKTOP || '')
  );
}

// KDE Wayland blocks Electron's focus()/show() from raising a window because
// libappindicator tray clicks don't carry an xdg-activation token. Bypass this
// by loading a tiny KWin script over D-Bus, which runs with the compositor's
// privileges and can activate the window directly, preserving geometry.
function _kwinActivateByPid(targetPid: number): boolean {
  const qdbus = _findQdbus();
  if (!qdbus) return false;

  const scriptPath = path.join(os.tmpdir(), `mailspring-activate-${targetPid}.js`);
  const scriptBody = `
(function () {
  var pid = ${targetPid};
  try {
    var list = workspace.windowList ? workspace.windowList() : workspace.clientList();
    for (var i = 0; i < list.length; i++) {
      var w = list[i];
      if (w.pid === pid && w.normalWindow) {
        if ('activeWindow' in workspace) {
          workspace.activeWindow = w;
        } else if (typeof workspace.activateClient === 'function') {
          workspace.activateClient(w);
        } else {
          workspace.activeClient = w;
        }
        break;
      }
    }
  } catch (e) {}
})();
`.trim();
  try {
    fs.writeFileSync(scriptPath, scriptBody);
  } catch (e) {
    return false;
  }

  const pluginName = `mailspring-activate-${Date.now()}`;
  const load = spawnSync(
    qdbus,
    ['org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting.loadScript', scriptPath, pluginName],
    { timeout: 1000, encoding: 'utf8' }
  );
  if (load.status !== 0) return false;
  const scriptId = (load.stdout || '').trim();
  if (!scriptId || !/^\d+$/.test(scriptId)) return false;

  const run = spawnSync(
    qdbus,
    ['org.kde.KWin', `/Scripting/Script${scriptId}`, 'org.kde.kwin.Script.run'],
    { timeout: 1000 }
  );
  spawnSync(qdbus, ['org.kde.KWin', `/Scripting/Script${scriptId}`, 'org.kde.kwin.Script.stop'], {
    timeout: 1000,
  });
  return run.status === 0;
}

function _getMenuTemplate(platform: string, application: Application) {
  const template = [
    {
      label: localized('New Message'),
      click: () => application.emit('application:new-message'),
    },
    {
      label: localized('Preferences'),
      click: () => application.emit('application:open-preferences'),
    },
    {
      type: 'separator',
    },
    {
      label: localized('Quit Wellspring'),
      click: () => application.emit('application:quit'),
    },
  ];

  if (platform !== 'win32') {
    template.unshift({
      label: `${localized('Open')} ${localized('Inbox')}`,
      click: () => application.emit('application:show-main-window'),
    });
  }

  return template;
}

function _getTooltip(unreadString: string) {
  return unreadString ? `${unreadString} unread messages` : '';
}

function _getIcon(iconPath: string) {
  if (!iconPath) {
    return nativeImage.createEmpty();
  }
  return nativeImage.createFromPath(iconPath);
}

class SystemTrayManager {
  _iconPath = null;
  _unreadString = null;
  _tray = null;
  _awaitingTrayHost = false;
  _platform: string = null;
  _application: Application;

  constructor(platform: string, application: Application) {
    this._platform = platform;
    this._application = application;
    this.initTray();

    app.on('browser-window-blur', this._onBrowserWindowBlur);

    this._application.config.onDidChange('core.workspace.systemTray', ({ newValue }) => {
      if (newValue === false) {
        this.destroyTray();
      } else {
        this.initTray();
      }
    });
  }

  _defaultIconPath() {
    if (this._platform !== 'linux') return null;

    const traySystemTheme =
      this._application.config.get('core.workspace.traySystemTheme') || 'automatic';
    let dark: string;
    if (traySystemTheme === 'dark') {
      dark = '-dark';
    } else if (traySystemTheme === 'light') {
      dark = '';
    } else {
      // Automatic: On GNOME/Unity the top bar panel is always dark regardless of the
      // application theme, so nativeTheme.shouldUseDarkColors is unreliable
      // for choosing the tray icon variant. Default to the light-on-dark icon.
      const desktop = (process.env.XDG_CURRENT_DESKTOP || '').toUpperCase();
      if (desktop.includes('GNOME') || desktop.includes('UNITY')) {
        dark = '-dark';
      } else {
        dark = nativeTheme.shouldUseDarkColors ? '-dark' : '';
      }
    }

    return path.join(
      this._application.resourcePath,
      'internal_packages',
      'system-tray',
      'assets',
      'linux',
      `MenuItem-Inbox-Full${dark}.png`
    );
  }

  _trayEnabled() {
    return this._application.config.get('core.workspace.systemTray') !== false;
  }

  async initTray() {
    if (!this._trayEnabled() || this._tray !== null || this._awaitingTrayHost) return;

    if (this._platform === 'linux') {
      this._awaitingTrayHost = true;
      try {
        await waitForStatusNotifierHost();
      } finally {
        this._awaitingTrayHost = false;
      }
      // The setting can be switched off while we were waiting for the host.
      if (!this._trayEnabled() || this._tray !== null) return;
    }

    this._tray = new Tray(_getIcon(this._iconPath || this._defaultIconPath()));
    this._tray.setToolTip(_getTooltip(this._unreadString));
    this._tray.addListener('click', this._onClick);
    this._tray.setContextMenu(
      Menu.buildFromTemplate(_getMenuTemplate(this._platform, this._application) as any)
    );
  }

  _lastBlurAt = 0;

  _onClick = () => {
    if (this._platform === 'darwin') return;

    const visibleWindows = this._application.windowManager.getVisibleWindows();
    if (visibleWindows.length === 0) {
      this._application.emit('application:show-main-window');
      return;
    }

    // On Wayland, clicking the tray removes keyboard focus from the app
    // before this handler fires, so BrowserWindow.getFocusedWindow() reports
    // null even when the window visually had focus. Treat a very recent blur
    // as "had focus" so we can still distinguish the two cases.
    const FOCUS_GRACE_MS = 250;
    const hadFocus =
      !!BrowserWindow.getFocusedWindow() || Date.now() - this._lastBlurAt < FOCUS_GRACE_MS;

    if (hadFocus) {
      visibleWindows.forEach((window) => window.hide());
    } else {
      // On Wayland the client can't raise itself or restore position after
      // hide/show. On KDE we bypass the focus-stealing prevention via a KWin
      // script over D-Bus (preserves geometry). Everywhere else, fall back to
      // focus()/show() which works on X11 / GNOME.
      const activated = _isKDEWayland() && _kwinActivateByPid(process.pid);
      if (!activated) {
        visibleWindows.forEach((window) => {
          window.show();
          window.focus();
        });
      }
    }
  };

  _onBrowserWindowBlur = () => {
    this._lastBlurAt = Date.now();
  };

  updateTraySettings(iconPath: string, unreadString: string) {
    if (this._iconPath !== iconPath) {
      this._iconPath = iconPath;
      if (this._tray) this._tray.setImage(_getIcon(this._iconPath));
    }
    if (this._unreadString !== unreadString) {
      this._unreadString = unreadString;
      if (this._tray) this._tray.setToolTip(_getTooltip(unreadString));
    }
  }

  destroyTray() {
    // Due to https://github.com/electron/electron/issues/17622
    // we cannot destroy the tray icon on linux.
    if (this._tray && process.platform !== 'linux') {
      this._tray.removeListener('click', this._onClick);
      this._tray.destroy();
      this._tray = null;
    }
  }
}

export default SystemTrayManager;
