// All of the Node.js APIs are available in the preload process.
// It has the same sandbox as a Chrome extension.

import { ipcRenderer } from "electron";
import { extractSession } from "./session-extract";

// Hand the Firebase auth session to main after login so the notification
// daemon can run on its own. Poll because the SDK writes to IndexedDB some
// time after DOMContentLoaded, and the token is refreshed periodically.
const startSessionPoll = () => {
  let lastRefreshToken = "";
  const poll = async () => {
    const session = await extractSession();
    if (!session || session.refreshToken === lastRefreshToken) return;
    lastRefreshToken = session.refreshToken;
    ipcRenderer.send("auth-session", session);
  };
  void poll();
  setInterval(() => void poll(), 15 * 1000);
};

window.addEventListener("DOMContentLoaded", () => {
  startSessionPoll();
});
