import { Notification } from "electron";
import {
  collection,
  doc,
  getFirestore,
  onSnapshot,
  query,
  terminate,
  Timestamp,
  where,
  type Firestore,
  type Unsubscribe,
} from "firebase/firestore";
import { releaseAuth, restoreAuth } from "./firebase-session";
import { capNotices, noticeUrl, type Notice } from "./notice";
import { noticeBody, notificationTitle } from "./notice-text";
import {
  stateFromCounts,
  totalFromCounts,
  type TrayState,
  type UnreadCounts,
} from "./tray-state";
import { log } from "./log";

export type ListenerHandlers = {
  setTray: (state: TrayState, unread: number) => void;
  openUrl: (url?: string) => void;
  onFailure: () => void;
};

// Watches the two documents that say what the tray should show and what just
// arrived, so nothing has to be polled. The notices query starts at "now", so
// the first snapshot is empty and a backlog never fires on startup.
export class NoticeListener {
  private unsubs: Unsubscribe[] = [];
  private db?: Firestore;
  private started = false;
  private failed = false;
  private teardowns: Promise<void> = Promise.resolve();

  constructor(private handlers: ListenerHandlers) {}

  get running(): boolean {
    return this.started;
  }

  // Never throws: false is the caller's signal to fall back to polling, so
  // everything - the leading stop() included - stays inside the try.
  async start(refreshToken: string): Promise<boolean> {
    try {
      await this.stop();
      const session = await restoreAuth(refreshToken);
      if (!session) return false;

      const db = getFirestore(session.app);
      this.db = db;
      this.watchTray(db, session.uid);
      this.watchNotices(db, session.uid);
      this.started = true;
      this.failed = false;
      log("listener-start", { uid: session.uid });
      return true;
    } catch (err) {
      log("listener-error", { at: "start", error: String(err) });
      await this.stop();
      return false;
    }
  }

  // Never rejects, and safe to call twice or concurrently: teardowns run one
  // at a time, so a start() that follows a failure's background cleanup does
  // not restore the session until that cleanup has released the old one.
  stop(): Promise<void> {
    const done = this.teardowns.then(
      () => this.teardown(),
      () => this.teardown()
    );
    this.teardowns = done;
    return done;
  }

  private async teardown(): Promise<void> {
    for (const unsub of this.unsubs) {
      try {
        unsub();
      } catch (err) {
        log("listener-error", { at: "unsubscribe", error: String(err) });
      }
    }
    this.unsubs = [];
    this.started = false;
    // terminate() drops the service instance synchronously before it returns
    // a promise, so it can throw outright on an instance already gone. The
    // field is cleared first and the call is wrapped, so neither that throw
    // nor a rejection can skip releaseAuth() or strand a Firestore here.
    const db = this.db;
    this.db = undefined;
    if (db) {
      try {
        await terminate(db);
      } catch (err) {
        log("listener-error", { at: "terminate", error: String(err) });
      }
    }
    try {
      await releaseAuth();
    } catch (err) {
      log("listener-error", { at: "release-auth", error: String(err) });
    }
  }

  // The fallback signal goes out before cleanup rather than after it: teardown
  // waits on releaseAuth(), which queues behind any in-flight restoreAuth()
  // with no timeout, and the app must not go that long without notifications.
  // The flag keeps one failure to one signal when both snapshots error at once.
  private fail(at: string, err: unknown): void {
    log("listener-error", { at, error: String(err) });
    if (this.failed) return;
    this.failed = true;
    this.started = false;
    try {
      this.handlers.onFailure();
    } catch (handlerErr) {
      log("listener-error", { at: "on-failure", error: String(handlerErr) });
    }
    void this.stop();
  }

  private watchTray(db: Firestore, uid: string): void {
    this.unsubs.push(
      onSnapshot(
        doc(db, "users", uid),
        (snap) => {
          // notice_unread_counts carries no is_display flag, unlike the old
          // API's categories - every category here counts toward the tray,
          // which is a deliberate divergence from the polling path.
          const counts = (snap.data()?.notice_unread_counts ?? {}) as UnreadCounts;
          this.handlers.setTray(stateFromCounts(counts), totalFromCounts(counts));
        },
        (err) => this.fail("tray-snapshot", err)
      )
    );
  }

  private watchNotices(db: Firestore, uid: string): void {
    const since = Timestamp.fromDate(new Date());
    this.unsubs.push(
      onSnapshot(
        query(collection(db, "users", uid, "notices"), where("created_at", ">", since)),
        (snap) => {
          const added = snap
            .docChanges()
            .filter((c) => c.type === "added")
            .map((c) => ({ documentId: c.doc.id, ...c.doc.data() }) as Notice);
          if (added.length) this.notify(added);
        },
        (err) => this.fail("notices-snapshot", err)
      )
    );
  }

  private notify(notices: Notice[]): void {
    if (!Notification.isSupported()) {
      log("listener-notify-skip", { reason: "unsupported", count: notices.length });
      return;
    }
    const { fire, collapsed } = capNotices(notices);
    for (const n of fire) this.show(notificationTitle(n), noticeBody(n), noticeUrl(n));
    if (collapsed > 0) {
      this.show("リベシティ", `他 ${collapsed} 件の通知があります`, undefined);
    }
    log("listener-notify", {
      fired: fire.map((n) => n.type),
      collapsed,
    });
  }

  private show(title: string, body: string, url?: string): void {
    const n = new Notification({ title, body });
    n.on("click", () => this.handlers.openUrl(url));
    n.show();
  }
}
