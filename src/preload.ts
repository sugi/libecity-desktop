// All of the Node.js APIs are available in the preload process.
// It has the same sandbox as a Chrome extension.

import { ipcRenderer } from "electron";
import { extractSession } from "./session-extract";
import { SessionWatch } from "./session-watch";

// Hand the Firebase auth session to main after login so the notification
// daemon can run on its own, and tell main when it goes away so the stored
// refresh token does not outlive the account it belongs to. Poll because the
// SDK writes to IndexedDB some time after DOMContentLoaded, and the token is
// refreshed periodically.
const startSessionPoll = () => {
  const watch = new SessionWatch();
  const poll = async () => {
    const action = watch.observe(await extractSession());
    if (action.kind === "session") ipcRenderer.send("auth-session", action.session);
    else if (action.kind === "signed-out") ipcRenderer.send("auth-signed-out");
  };
  void poll();
  setInterval(() => void poll(), 15 * 1000);
};

window.addEventListener("DOMContentLoaded", () => {
  startSessionPoll();
});
