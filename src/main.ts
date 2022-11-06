import { app, BrowserWindow, ipcMain, shell, Tray } from "electron";
import * as path from "path";

function createWindow() {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    height: 1200,
    width: 1600,
    title: "リベシティ",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // and load the index.html of the app.
  // mainWindow.loadFile(path.join(__dirname, "../index.html"));
  mainWindow.loadURL("https://libecity.com/");

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  mainWindow.on("close", (e) => {
    mainWindow.hide();
    e.preventDefault();
  });

  ipcMain.on("show-main-window", () => {
    mainWindow.show();
    mainWindow.focus();
  });

  ipcMain.on("hide-main-window", () => {
    mainWindow.hide();
  });

  // Open the DevTools.
  mainWindow.webContents.openDevTools();

  return mainWindow;
}

app.setName("libecity-desktop");

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  const win = createWindow();

  const tray = new Tray("./trayicon.png");
  tray.setTitle("リベシティ");
  tray.setToolTip("リベシティ");
  tray.addListener("click", () => {
    win.show();
    win.focus();
  });

  app.on("activate", function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// In this file you can include the rest of your app"s specific main process
// code. You can also put them in separate files and require them here.
