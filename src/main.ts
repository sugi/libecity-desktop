import { app, BrowserWindow, ipcMain, Menu, shell, Tray } from "electron";
import * as path from "path";
import * as fs from "fs";
import windowStateKeeper = require("electron-window-state");

const iconPath = {
  default: path.join(__dirname, "..", "images", "trayicon.png"),
  hasNotification: path.join(__dirname, "..", "images", "trayicon-rd.png"),
  hasNewMessage: path.join(__dirname, "..", "images", "trayicon-gd.png"),
};

let terminating = false;
let mainWindow: BrowserWindow | undefined;

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

ipcMain.on("inject-renderer", () => {
  if (!mainWindow) return;
  mainWindow.webContents.executeJavaScript(
    fs.readFileSync(path.join(__dirname, "renderer.js")).toString()
  );
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
  win.loadURL("https://libecity.com/");

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://libecity.com/")) {
      win.loadURL(url);
    } else if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  win.on("close", (e) => {
    mainWindow = undefined;
  });

  winState.manage(win);
  return win;
}

app.setName("libecity-desktop");

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  if (terminating) return;

  mainWindow = createWindow();

  const tray = new Tray(iconPath.default);
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

  ipcMain.on("icon-notification", () => {
    tray.setImage(iconPath.hasNotification);
  });
  ipcMain.on("icon-new-message", () => {
    tray.setImage(iconPath.hasNewMessage);
  });
  ipcMain.on("icon-default", () => {
    tray.setImage(iconPath.default);
  });

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
