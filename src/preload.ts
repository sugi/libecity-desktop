// All of the Node.js APIs are available in the preload process.
// It has the same sandbox as a Chrome extension.

import { ipcRenderer } from "electron";

type NotificationItem = { title: string; body: string; date: Date };

const getNotifications = (): NotificationItem[] => {
  const container = document.querySelector("#notificationMenu ul");
  if (!container) return [];
  return Array.from(
    container.querySelectorAll(":not(.is_noInfo).nav-item")
  ).map((i) => {
    return {
      title: i.querySelector(".notificationTitle")?.textContent ?? "",
      body: i.querySelector(".notificationDetail")?.textContent ?? "",
      date: new Date(
        Array.from(i.querySelector("time")?.childNodes ?? [])
          .map((n) => n.textContent)
          .join(" ")
      ),
    };
  });
};

const startNotificationObserver = () => {
  let lastChecked = new Date(0);

  const notifyNewItmes = () => {
    if (!document.querySelector(".notificationIcon.is_notifice")) return;
    getNotifications()
      .reverse()
      .forEach((i) => {
        if (i.date < lastChecked) return;
        new Notification(i.title, {
          body: i.body,
        }).addEventListener("click", () =>
          ipcRenderer.send("show-main-window")
        );
      });
    lastChecked = new Date();
  };
  setInterval(notifyNewItmes, 5 * 1000);
};

window.addEventListener("DOMContentLoaded", () => {
  startNotificationObserver();
});
