import { app, BrowserWindow, ipcMain, Menu, shell, Tray } from "electron";
import * as path from "path";
import windowStateKeeper from "electron-window-state";
import squirrelStartup from "electron-squirrel-startup";
import { attachTrafficDump, closeDump, openDump, record } from "./traffic-dump";
import { type AuthSession } from "./firebase-auth";
import { loadRefreshToken, saveRefreshToken } from "./session-store";
import { log } from "./log";
import { NotificationDaemon, type TrayState } from "./notification-daemon";
import { NoticeListener } from "./notice-listener";
import { renderTrayIcon } from "./tray-icon";
import { classifyUrl } from "./url-policy";

// Chromium deletes an IndexedDB store whose Blink serialization format is
// newer than its own, so hopping between Electron versions during development
// wipes the login state. Keeping the dev profile separate also gives it its own
// single-instance lock, so a dev run and the installed app can coexist.
if (!app.isPackaged) {
  app.setPath("userData", `${app.getPath("userData")}-dev`);
}

// Sticky for the life of the process: once true, nothing here may start the
// daemon again. Set by the tray's quit item and, as a catch-all for every
// other way a quit can begin (Cmd+Q, OS shutdown, a second instance losing
// the lock), by before-quit itself - synchronously, so it is already true
// before listener.stop()'s queued teardown can run its demote.
let terminating = false;
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;

// Squirrel runs the exe with --squirrel-install/--squirrel-updated to have it
// create and migrate shortcuts, then exit. Booting the real app instead leaves
// the install with no shortcuts, and on update the second process would lose
// the lock below and quit before the migration ran.
if (squirrelStartup) {
  terminating = true;
  app.quit();
}

if (!app.requestSingleInstanceLock()) {
  terminating = true;
  app.quit();
}

const showMainWindow = () => {
  if (typeof mainWindow === "undefined") {
    mainWindow = createWindow();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
};
const hideMainWindow = () => {
  mainWindow?.hide();
};

// Notifications carry a target, but the daemon's fallback path and the
// listener's collapsed "他 N 件" toast pass none by design - that just means
// "show the window", not a hostile or unparseable URL worth a rejection log.
const openUrl = (url?: string) => {
  if (url === undefined) {
    showMainWindow();
    return;
  }
  switch (classifyUrl(url)) {
    case "internal":
      if (typeof mainWindow === "undefined") {
        mainWindow = createWindow(url);
        return;
      }
      mainWindow.show();
      mainWindow.focus();
      void mainWindow.loadURL(url as string);
      return;
    case "external":
      void shell.openExternal(url as string);
      return;
    case "reject":
      log("open-url-rejected", { url });
      showMainWindow();
      return;
  }
};

// The daemon polls; only touch the tray when the picture would change.
let shownTray: string | undefined;
const setTray = (state: TrayState, unread: number) => {
  if (!tray) return;
  const key = `${state}:${unread}`;
  if (key === shownTray) return;
  shownTray = key;
  tray.setImage(renderTrayIcon(state, unread));
  tray.setToolTip(unread > 0 ? `リベシティ (${unread})` : "リベシティ");
};

const daemon = new NotificationDaemon({ setTray, openUrl });

// Which path is live is decided by the listener's health, not by whether it
// started: the poll runs whenever the listener is not reaching the server, so
// startup, a terminal error and a connection that merely went quiet are all
// the same case here. An outage that never resolves therefore polls forever,
// which is the degradation we want.
let listenerHealthy = false;
const listener = new NoticeListener({
  setTray,
  openUrl,
  setHealthy: (healthy) => {
    if (healthy === listenerHealthy) return;
    listenerHealthy = healthy;
    if (healthy) {
      daemon.stop();
      return;
    }
    // A quit in progress can still deliver this demote (teardown() signals
    // before its awaits), and by then falling back to polling would be
    // re-arming what before-quit just stopped.
    if (terminating) return;
    const token = loadRefreshToken();
    if (token) {
      daemon.start(token);
    } else {
      log("poll-fallback-skipped", { reason: "no-refresh-token" });
    }
  },
});

// The listener is preferred, but nothing bounds how long its start() takes -
// the token refresh underneath it is a bare fetch with no AbortSignal, so a
// stalled connect would leave the app with neither path running and nothing
// logged. The poll therefore runs from the start, and only setHealthy stops
// it: start() resolving true means the subscriptions are registered, which is
// not the same as data arriving. The daemon's first tick only seeds its
// baseline, so the overlap cannot double-fire a notification.

// The token the listener is currently running with (or was last asked to
// run with), so a repeat auth-session for the same account can be told apart
// from one worth acting on.
let listenerToken: string | undefined;
const startNotifications = (refreshToken: string) => {
  daemon.start(refreshToken);
  listenerToken = refreshToken;
  void listener.start(refreshToken).then((ok) => {
    if (!ok) log("listener-start-failed");
  });
};

function createWindow(
  url = "https://libecity.com/",
  options?: Electron.BrowserWindowConstructorOptions
) {
  const winState = windowStateKeeper({
    defaultWidth: 1000,
    defaultHeight: 800,
  });

  // Create the browser window.
  const win = new BrowserWindow({
    title: "リベシティ",
    width: winState.width,
    height: winState.height,
    x: winState.x,
    y: winState.y,
    ...options,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // and load the index.html of the app.
  // win.loadFile(path.join(__dirname, "../index.html"));
  void attachTrafficDump(win.webContents);
  win.loadURL(url);

  win.webContents.setWindowOpenHandler(({ url }) => {
    switch (classifyUrl(url)) {
      case "internal":
        win.loadURL(url);
        break;
      case "external":
        shell.openExternal(url);
        break;
      case "reject":
        break;
    }
    return { action: "deny" };
  });

  win.on("close", () => {
    mainWindow = undefined;
  });

  winState.manage(win);
  return win;
}

app.setName("libecity-desktop");

// The webview hands over the Firebase session after login. Persist the refresh
// token so the daemon can run without a window, and (re)start it.
ipcMain.on("auth-session", (_event, session: AuthSession) => {
  record("auth-session", {
    uid: session.uid,
    email: session.email,
    hasRefreshToken: Boolean(session.refreshToken),
    expirationTime: session.expirationTime,
  });
  if (!session.refreshToken) return;
  // This reaches startNotifications(), which reaches daemon.start(), so it
  // must not run once a quit is under way.
  if (terminating) return;
  saveRefreshToken(session.refreshToken);
  // Every window sends this on open even when nothing changed - the preload
  // has no way to know the token it read back is the one the listener is
  // already running with. Skip the restart in that case: it would otherwise
  // tear down and re-subscribe a healthy listener on every window, losing
  // whatever arrives during the gap. A different token (another account) or a
  // listener that is not running (this is then the self-heal path, since
  // nothing else retries a failed start on its own) still goes through.
  if (session.refreshToken === listenerToken && listener.running) return;
  startNotifications(session.refreshToken);
});

app.whenReady().then(() => {
  if (terminating) return;

  const dumpPath = openDump();
  if (dumpPath) console.log(`[dump] writing API traffic to ${dumpPath}`);

  mainWindow = createWindow();

  // A tray failure must not abort the rest of startup (daemon, activate).
  try {
    tray = new Tray(renderTrayIcon("default", 0));
    tray.setTitle("リベシティ");
    tray.setToolTip("リベシティ");

    const contextMenu = Menu.buildFromTemplate([
      { label: "チャットを表示", click: showMainWindow },
      { type: "separator" },
      {
        label: "終了する",
        click() {
          terminating = true;
          app.quit();
        },
      },
    ]);

    tray.setContextMenu(contextMenu);
    tray.addListener("click", showMainWindow);
    console.log(`[tray] created on ${process.platform}`);
  } catch (err) {
    console.error("[tray] failed to create:", err);
  }

  // Start notifications immediately from a stored session, before any login -
  // this is what lets notifications work with the window closed.
  const stored = loadRefreshToken();
  if (stored) startNotifications(stored);

  app.on("activate", function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && terminating) {
    app.quit();
  }
});

// In this file you can include the rest of your app"s specific main process
// code. You can also put them in separate files and require them here.

// The dump stream buffers, and a quit would otherwise drop the tail - which is
// the part worth reading after a session that misbehaved.
app.on("will-quit", closeDump);

app.on("second-instance", () => {
  showMainWindow();
});

// An open Firestore stream holds handles that would outlive the quit. Setting
// terminating here, first and synchronously, closes off every daemon.start()
// call in this file before listener.stop()'s queued teardown - which signals
// its demote ahead of its own awaits - can reach the setHealthy handler above.
app.on("before-quit", () => {
  terminating = true;
  daemon.stop();
  void listener.stop();
});

ipcMain.on("show-main-window", showMainWindow);

ipcMain.on("hide-main-window", hideMainWindow);
