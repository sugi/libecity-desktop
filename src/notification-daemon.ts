import { Notification } from "electron";
import { LibecityClient, type NoticeCategory } from "./libecity-api";
import { record } from "./traffic-dump";

export type TrayState = "default" | "message" | "notice";

const TYPE_LABELS: Record<string, string> = {
  message: "メッセージ",
  tweet: "つぶやき",
  official_dm: "運営DM",
  dm: "DM",
  follow: "フォロー",
  usercommunity: "コミュニティ",
  event: "イベント",
  live: "ライブ",
  point: "ポイント",
  micro_service: "サービス",
};

export type DaemonHandlers = {
  setTrayState: (state: TrayState) => void;
  openApp: () => void;
};

// Polls the libecity notice API on its own, independent of any window, and
// drives desktop notifications + the tray icon. Replaces the old DOM-scraping
// observer in the preload.
export class NotificationDaemon {
  private client?: LibecityClient;
  private timer?: ReturnType<typeof setInterval>;
  private lastCreatedAt = new Map<string, string>(); // type -> last_created_at
  private seeded = false;
  private polling = false;

  constructor(
    private handlers: DaemonHandlers,
    private intervalMs = 30_000
  ) {}

  start(refreshToken: string): void {
    this.client = new LibecityClient(refreshToken);
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    void this.poll();
  }

  // A fresh login may be a different account, so drop the baseline and re-seed.
  updateRefreshToken(refreshToken: string): void {
    if (!this.client) {
      this.start(refreshToken);
      return;
    }
    this.client.updateRefreshToken(refreshToken);
    this.seeded = false;
    this.lastCreatedAt.clear();
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async poll(): Promise<void> {
    if (!this.client || this.polling) return;
    this.polling = true;
    try {
      const categories = await this.client.getCategories();
      this.handlers.setTrayState(computeState(categories));
      this.notifyNew(categories);
    } catch (err) {
      record("daemon-poll-error", { error: String(err) });
    } finally {
      this.polling = false;
    }
  }

  private notifyNew(categories: NoticeCategory[]): void {
    const fresh = diffNotifications(this.lastCreatedAt, categories, this.seeded);
    this.seeded = true;
    for (const c of fresh) this.fire(c);
  }

  private fire(c: NoticeCategory): void {
    if (!Notification.isSupported()) return;
    const label = TYPE_LABELS[c.type];
    const n = new Notification({
      title: label ? `リベシティ - ${label}` : "リベシティ",
      body: c.latest_notice_title ?? "新しいお知らせがあります",
    });
    n.on("click", () => this.handlers.openApp());
    n.show();
    record("daemon-notify", { type: c.type, title: c.latest_notice_title });
  }
}

// Notice (bell) takes priority over unread chat messages, matching the old
// tray behaviour where the notification icon outranked the message icon.
export function computeState(categories: NoticeCategory[]): TrayState {
  const displayed = categories.filter((c) => c.is_display);
  if (displayed.some((c) => c.type !== "message" && c.unread_count > 0)) return "notice";
  if (displayed.some((c) => c.type === "message" && c.unread_count > 0)) return "message";
  return "default";
}

// Which categories should fire a desktop notification, updating `lastSeen` in
// place. The first call (seeded=false) only records the baseline and returns
// nothing, so pre-existing unread items don't spam on startup.
export function diffNotifications(
  lastSeen: Map<string, string>,
  categories: NoticeCategory[],
  seeded: boolean
): NoticeCategory[] {
  const fresh: NoticeCategory[] = [];
  for (const c of categories) {
    const at = c.last_created_at ?? "";
    const prev = lastSeen.get(c.type);
    if (at) lastSeen.set(c.type, at);
    if (seeded && c.is_display && c.unread_count > 0 && at && prev && at > prev) {
      fresh.push(c);
    }
  }
  return fresh;
}
