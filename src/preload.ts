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
  let lastNotifiedItems: NotificationItem[] = [];

  const notifyNewNotifications = () => {
    const notified: NotificationItem[] = [];
    if (!document.querySelector(".notificationIcon.is_notifice")) {
      ipcRenderer.send("icon-default");
      return;
    }
    ipcRenderer.send("icon-notification");
    const items = getNotifications();
    if (
      !items.length ||
      (lastNotifiedItems.length &&
        JSON.stringify(items[0]) ===
          JSON.stringify(lastNotifiedItems[lastNotifiedItems.length - 1]))
    )
      return;
    items
      .concat()
      .reverse()
      .filter(
        (i) =>
          !lastNotifiedItems.length ||
          (lastNotifiedItems[lastNotifiedItems.length - 1].date <= i.date &&
            !lastNotifiedItems.find(
              (l) => JSON.stringify(i) === JSON.stringify(l)
            ))
      )
      .forEach((i) => {
        new Notification(i.title, {
          body: i.body,
        }).addEventListener("click", () =>
          ipcRenderer.send("show-main-window")
        );
        notified.push(i);
      });
    lastNotifiedItems = notified;
  };
  setTimeout(notifyNewNotifications, 5000);
  setInterval(notifyNewNotifications, 30 * 1000);
};

window.addEventListener("DOMContentLoaded", () => {
  startNotificationObserver();
});
