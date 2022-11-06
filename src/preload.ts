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
  console.log("loaded");
  startNotificationObserver();

  const replaceText = (selector: string, text: string) => {
    const element = document.querySelector(selector) as HTMLElement;
    if (element) {
      element.innerText = text;
    }
  };

  setTimeout(() => {
    replaceText(
      "#content-mainNav > div.form_data_area.is_search > div > div.header_searchBtn_wrap > div.header_searchBtn.searchTrend > a > span",
      "とれんど"
    );
    document
      .querySelector(
        "#content-mainNav > div.form_data_area.is_search > div > div.header_searchBtn_wrap > div.header_searchBtn.searchTrend > a"
      )
      ?.addEventListener("click", () => {
        console.log("notify");
        new Notification("hoge", { body: "fuga" }).addEventListener(
          "click",
          (e) => {
            ipcRenderer.send("show-main-window");
            console.log(e);
          }
        );
      });
  }, 5000);
});
