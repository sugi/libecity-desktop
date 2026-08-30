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

// log() writes to the dump stream and to the console, and either can throw
// (EPIPE, a dump file closed under it). Nothing in this file may lose the
// fallback signal or raise an unhandled rejection because a diagnostic line
// failed, so every log call here goes through this guard instead.
function safeLog(kind: string, data?: unknown): void {
  try {
    log(kind, data);
  } catch {
    // Diagnostics are best-effort; a lost line must not change control flow.
  }
}

// Watches the two documents that say what the tray should show and what just
// arrived, so nothing has to be polled. The notices query starts at "now", so
// the first snapshot is empty and a backlog never fires on startup.
export class NoticeListener {
  private unsubs: Unsubscribe[] = [];
  private db?: Firestore;
  private started = false;
  private failed = false;
  private ops: Promise<void> = Promise.resolve();

  constructor(private handlers: ListenerHandlers) {}

  get running(): boolean {
    return this.started;
  }

  // start() and stop() share one chain because restoreAuth() and releaseAuth()
  // share one queue in firebase-session with no timeout on either leg. A
  // restore left off this chain would take its place in that queue, suspend on
  // the token refresh, and let a later teardown's releaseAuth line up behind
  // it - deleting the app the restore is about to hand back, and erroring the
  // subscriptions it had just installed. Every restore has to stay paired with
  // the teardown ahead of it, which is what this chain buys.
  //
  // The position is taken synchronously and nothing is awaited before the
  // caller gets its promise, so registering work is enough to order it. Links
  // are isolated: each caller keeps its own promise, and a rejected one is
  // swallowed before the next link chains off it, so one failure cannot poison
  // the queue.
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.ops.then(op, op);
    this.ops = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  // Never rejects: false is the caller's signal to fall back to polling.
  start(refreshToken: string): Promise<boolean> {
    return this.enqueue(() => this.startImpl(refreshToken));
  }

  // Never rejects, and safe to call twice or concurrently. The release is
  // ordered, not immediate: this registers a teardown behind whatever is
  // already queued, and clears nothing synchronously. A caller that fires and
  // forgets can still get tray updates and notifications for the old account
  // until the chain drains - await it to be sure they have stopped.
  stop(): Promise<void> {
    return this.enqueue(() => this.teardown());
  }

  // Runs as a chain link, so it calls teardown() directly: going through
  // stop() would queue behind itself and deadlock. firebase-session splits its
  // *Impl functions from its queued entry points for the same reason.
  private async startImpl(refreshToken: string): Promise<boolean> {
    try {
      await this.teardown();
      const session = await restoreAuth(refreshToken);
      if (!session) return false;

      const db = getFirestore(session.app);
      this.db = db;
      this.watchTray(db, session.uid);
      this.watchNotices(db, session.uid);
      this.started = true;
      this.failed = false;
      safeLog("listener-start", { uid: session.uid });
      return true;
    } catch (err) {
      safeLog("listener-error", { at: "start", error: String(err) });
      try {
        await this.teardown();
      } catch {
        // teardown() guards each of its own steps; this keeps "start() returns
        // false rather than rejecting" true even if a future edit slips one.
      }
      return false;
    }
  }

  private async teardown(): Promise<void> {
    for (const unsub of this.unsubs) {
      try {
        unsub();
      } catch (err) {
        safeLog("listener-error", { at: "unsubscribe", error: String(err) });
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
        safeLog("listener-error", { at: "terminate", error: String(err) });
      }
    }
    try {
      await releaseAuth();
    } catch (err) {
      safeLog("listener-error", { at: "release-auth", error: String(err) });
    }
  }

  // The fallback signal goes out before cleanup rather than after it: teardown
  // waits on releaseAuth(), which queues behind any in-flight restoreAuth()
  // with no timeout, and the app must not go that long without notifications.
  // The flag keeps one failure to one signal when both snapshots error at once.
  // stop() is called first, not after the handler: its enqueue is synchronous
  // and blocks on nothing, so onFailure() still fires in the same turn with
  // nothing awaited before it, but registering first puts this teardown ahead
  // of any start() a synchronously-retrying handler enqueues.
  private fail(at: string, err: unknown): void {
    safeLog("listener-error", { at, error: String(err) });
    if (this.failed) return;
    this.failed = true;
    this.started = false;
    void this.stop();
    try {
      this.handlers.onFailure();
    } catch (handlerErr) {
      safeLog("listener-error", { at: "on-failure", error: String(handlerErr) });
    }
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
          try {
            this.handlers.setTray(stateFromCounts(counts), totalFromCounts(counts));
          } catch (err) {
            safeLog("listener-error", { at: "set-tray", error: String(err) });
          }
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
          if (added.length) {
            try {
              this.notify(added);
            } catch (err) {
              safeLog("listener-error", { at: "notify", error: String(err) });
            }
          }
        },
        (err) => this.fail("notices-snapshot", err)
      )
    );
  }

  private notify(notices: Notice[]): void {
    if (!Notification.isSupported()) {
      safeLog("listener-notify-skip", { reason: "unsupported", count: notices.length });
      return;
    }
    const { fire, collapsed } = capNotices(notices);
    for (const n of fire) this.show(notificationTitle(n), noticeBody(n), noticeUrl(n));
    if (collapsed > 0) {
      this.show("リベシティ", `他 ${collapsed} 件の通知があります`, undefined);
    }
    safeLog("listener-notify", {
      fired: fire.map((n) => n.type),
      collapsed,
    });
  }

  private show(title: string, body: string, url?: string): void {
    const n = new Notification({ title, body });
    n.on("click", () => {
      try {
        this.handlers.openUrl(url);
      } catch (err) {
        safeLog("listener-error", { at: "open-url", error: String(err) });
      }
    });
    n.show();
  }
}
