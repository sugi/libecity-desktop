// Minimal Electron tray, no forge / no build / no app code. Bisects whether
// the tray registration failure is environmental (dev-mode Electron) or caused
// by something in our app. Run: npx electron scripts/tray-test.cjs
const { app, Tray, Menu } = require("electron");
const path = require("path");

app.on("window-all-closed", () => {});

app.whenReady().then(() => {
  const icon = path.join(__dirname, "..", "images", "trayicon.png");
  let tray;
  try {
    tray = new Tray(icon);
    tray.setToolTip("tray-test");
    tray.setContextMenu(
      Menu.buildFromTemplate([{ label: "quit", click: () => app.quit() }])
    );
    console.log(`[tray-test] created, pid=${process.pid}, icon=${icon}`);
  } catch (err) {
    console.error("[tray-test] failed:", err);
  }
  // keep the reference alive and the process running
  global.__tray = tray;
  console.log("[tray-test] running; query the SNI watcher in another terminal");
});
