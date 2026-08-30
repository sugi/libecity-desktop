import { app, BrowserWindow, ipcMain, Menu, shell, Tray } from "electron";
import * as path from "path";
import windowStateKeeper = require("electron-window-state");
import { attachTrafficDump, openDump, record } from "./traffic-dump";
import { type AuthSession } from "./firebase-probe";
import { loadRefreshToken, saveRefreshToken } from "./session-store";
import { NotificationDaemon, type TrayState } from "./notification-daemon";

const iconPath = {
  default: path.join(__dirname, "..", "images", "trayicon.png"),
  notice: path.join(__dirname, "..", "images", "trayicon-rd.png"),
  message: path.join(__dirname, "..", "images", "trayicon-gd.png"),
};

let terminating = false;
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;

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

const daemon = new NotificationDaemon({
  setTrayState: (state: TrayState) => tray?.setImage(iconPath[state]),
  openApp: showMainWindow,
});

function createWindow(options?: Electron.BrowserWindowConstructorOptions) {
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
  win.loadURL("https://libecity.com/");

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://libecity.com/")) {
      win.loadURL(url);
    } else if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
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
  saveRefreshToken(session.refreshToken);
  daemon.updateRefreshToken(session.refreshToken);
});

app.whenReady().then(() => {
  if (terminating) return;

  const dumpPath = openDump();
  console.log(`[dump] writing API traffic to ${dumpPath}`);

  mainWindow = createWindow();

  // A tray failure must not abort the rest of startup (daemon, activate).
  try {
    tray = new Tray(iconPath.default);
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
    console.log(`[tray] created on ${process.platform}, icon=${iconPath.default}`);
  } catch (err) {
    console.error("[tray] failed to create:", err);
  }

  // Start notifications immediately from a stored session, before any login -
  // this is what lets notifications work with the window closed.
  const stored = loadRefreshToken();
  if (stored) daemon.start(stored);

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

app.on("second-instance", () => {
  showMainWindow();
});

ipcMain.on("show-main-window", showMainWindow);

ipcMain.on("hide-main-window", hideMainWindow);
