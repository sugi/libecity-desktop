import { Notification } from "electron";
import { LibecityClient, type NoticeCategory } from "./libecity-api";
import { log } from "./log";
import { TYPE_LABELS } from "./notice-text";
import { computeState, unreadTotal, type TrayState } from "./tray-state";

export { type TrayState };

export type DaemonHandlers = {
  setTray: (state: TrayState, unread: number) => void;
  openUrl: (url?: string) => void;
};

// Only the one call the daemon makes, so a test can hand it a client it drives
// by hand rather than a real one with a token and a network behind it.
type CategorySource = { getCategories: () => Promise<NoticeCategory[]> };

export type ClientFactory = (refreshToken: string) => CategorySource;

// log() reaches the console and the dump stream, and either can throw. A lost
// diagnostic must not become an unhandled rejection inside a timer callback.
function safeLog(kind: string, data?: unknown): void {
  try {
    log(kind, data);
  } catch {
    // Diagnostics are best-effort; a lost line must not change control flow.
  }
}

// Polls the libecity notice API on its own, independent of any window, and
// drives desktop notifications + the tray icon. Replaces the old DOM-scraping
// observer in the preload.
export class NotificationDaemon {
  private client?: CategorySource;
  private timer?: ReturnType<typeof setInterval>;
  private lastCreatedAt = new Map<string, string>(); // type -> last_created_at
  private seeded = false;
  private polling = false;
  // Bumped by every start and stop. A poll carries the value it started with,
  // so one that was in flight across an account switch cannot paint the new
  // account's tray or seed the new account's baseline with the old one's data.
  private generation = 0;
  private pendingGeneration?: number;

  constructor(
    private handlers: DaemonHandlers,
    private intervalMs = 15 * 60_000,
    private makeClient: ClientFactory = (token) => new LibecityClient(token)
  ) {}

  // A new client means a new baseline: the caller may be a different account,
  // or the same one after a gap during which the listener already showed
  // whatever arrived, so the first poll after any start must seed rather than
  // fire against a stale one.
  start(refreshToken: string): void {
    const generation = ++this.generation;
    this.client = this.makeClient(refreshToken);
    this.seeded = false;
    this.lastCreatedAt.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.poll(this.generation), this.intervalMs);
    void this.poll(generation);
  }

  stop(): void {
    this.generation++;
    this.pendingGeneration = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async poll(generation: number): Promise<void> {
    if (!this.client) return;
    // A poll already running belongs to whichever client was current when it
    // started; queue this one rather than dropping it, or a start() that lands
    // mid-poll would wait a whole interval for its first real read.
    if (this.polling) {
      this.pendingGeneration = generation;
      return;
    }
    this.polling = true;
    try {
      const categories = await this.client.getCategories();
      if (generation !== this.generation) {
        safeLog("daemon-poll-stale", { generation });
        return;
      }
      this.handlers.setTray(computeState(categories), unreadTotal(categories));
      this.notifyNew(categories);
    } catch (err) {
      safeLog("daemon-poll-error", { error: String(err) });
    } finally {
      this.polling = false;
      const pending = this.pendingGeneration;
      this.pendingGeneration = undefined;
      // Only the current generation's queued poll is worth running, and it can
      // queue nothing itself - polling is already false here - so this hands
      // off at most one level per real start or tick.
      if (pending !== undefined && pending === this.generation) void this.poll(pending);
    }
  }

  private notifyNew(categories: NoticeCategory[]): void {
    const fresh = diffNotifications(this.lastCreatedAt, categories, this.seeded);
    this.seeded = true;
    for (const c of fresh) {
      // The baseline has already advanced past all of these, so one that throws
      // on its way out would never be offered again. Losing the rest of the
      // batch with it is not a trade worth making.
      try {
        this.fire(c);
      } catch (err) {
        safeLog("daemon-notify-error", { type: c.type, error: String(err) });
      }
    }
  }

  private fire(c: NoticeCategory): void {
    if (!Notification.isSupported()) return;
    const label = TYPE_LABELS[c.type];
    const n = new Notification({
      title: label ? `リベシティ - ${label}` : "リベシティ",
      body: c.latest_notice_title ?? "新しいお知らせがあります",
    });
    n.on("click", () => {
      try {
        this.handlers.openUrl();
      } catch (err) {
        safeLog("daemon-open-url-error", { error: String(err) });
      }
    });
    n.show();
    safeLog("daemon-notify", { type: c.type, title: c.latest_notice_title });
  }
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
