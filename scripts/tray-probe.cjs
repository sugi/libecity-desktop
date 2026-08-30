// Self-checking tray probe: creates a tray, waits, then asks the KDE
// StatusNotifierWatcher whether an item owned by THIS process registered, and
// prints a one-line PASS/FAIL. Used to bisect which Electron version still
// registers a tray. Run via: npx electron scripts/tray-probe.cjs
const { app, Tray } = require("electron");
const { execSync } = require("child_process");
const path = require("path");

app.on("window-all-closed", () => {});

const selfRegistered = () => {
  let items;
  try {
    items = execSync(
      "qdbus org.kde.StatusNotifierWatcher /StatusNotifierWatcher RegisteredStatusNotifierItems",
      { encoding: "utf8" }
    ).trim().split("\n");
  } catch {
    return false;
  }
  for (const line of items) {
    const svc = line.split("/")[0];
    if (!svc) continue;
    try {
      const pid = execSync(
        `qdbus org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.GetConnectionUnixProcessID ${svc}`,
        { encoding: "utf8" }
      ).trim();
      if (Number(pid) === process.pid) return true;
    } catch {
      // ignore items we can't resolve
    }
  }
  return false;
};

app.whenReady().then(() => {
  const icon = path.join(__dirname, "..", "images", "trayicon.png");
  let created = false;
  try {
    const tray = new Tray(icon);
    tray.setToolTip("tray-probe");
    global.__tray = tray;
    created = true;
  } catch (e) {
    console.log(`CREATE_FAIL ${e.message}`);
  }
  setTimeout(() => {
    console.log(
      `TRAY_PROBE electron=${process.versions.electron} created=${created} registered=${selfRegistered()}`
    );
    app.quit();
  }, 2500);
});
