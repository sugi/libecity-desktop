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
  // "Healthy" means both subscriptions are being served from the server, not
  // that they are registered. It is only called on a change, so the caller can
  // treat every call as an edge and start or stop its fallback on it.
  setHealthy: (healthy: boolean) => void;
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

// created_at is written by the server, so a window anchored at the client's
// own "now" is only as good as the workstation clock: a clock running fast
// silently excludes new notices until the server catches up. Probe data also
// shows created_at landing about 2.5 s before the document's createTime, so
// even a correct clock can miss a write that was in flight at subscribe time.
// Overlapping the window absorbs both; the baseline below, not the window, is
// what keeps the backlog from firing.
const OVERLAP_MS = 5 * 60_000;

// A session runs for weeks, so the delivered-id set is trimmed to its most
// recent entries rather than kept whole.
const SEEN_CAP = 500;
const SEEN_KEEP = 250;

// Health here is read off snap.metadata.fromCache, and the SDK only delivers a
// snapshot for a sync-state change - the cache/server transition that carries
// that flag - when this is set: QueryListener.shouldRaiseEvent returns
// includeMetadataChanges for a snapshot whose docChanges are empty. Without
// it, dropping the connection while idle would raise nothing and the listener
// would keep claiming health while blind, and a connection restored during a
// quiet spell would never be noticed. Metadata-only document changes are still
// stripped from docChanges() by default, so this cannot fabricate an "added".
const LISTEN_OPTIONS = { includeMetadataChanges: true } as const;

// Watches the two documents that say what the tray should show and what just
// arrived, so nothing has to be polled. The first snapshot the server serves
// for the notices query is a baseline: its ids are recorded and nothing fires
// for them, so a backlog never toasts on startup and a reconnect cannot
// re-deliver notifications that were already shown.
export class NoticeListener {
  private unsubs: Unsubscribe[] = [];
  private db?: Firestore;
  private started = false;
  private startedUid?: string;
  private readonly live = new Set<Notification>();
  private failed = false;
  private ops: Promise<void> = Promise.resolve();
  // Health is per subscription: a snapshot is evidence only about its own
  // stream. Both must be served from the server before the listener counts as
  // healthy, because either one going quiet loses part of the picture.
  private trayHealthy = false;
  private noticesHealthy = false;
  // The last value handed to setHealthy. Nothing is signalled until the
  // aggregate moves off it, so a flapping connection cannot restart the
  // fallback repeatedly.
  private signalledHealthy = false;
  private baselined = false;
  private delivered = new Set<string>();

  constructor(private handlers: ListenerHandlers) {}

  get running(): boolean {
    return this.started;
  }

  // The account the listener is currently running for (or was last started
  // for), so a caller can tell a repeat auth-session for the same account
  // apart from one that needs a restart - the account's identity, unlike the
  // refresh token, does not rotate out from under this comparison.
  get uid(): string | undefined {
    return this.startedUid;
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
  //
  // true here means *registered*, not working: onSnapshot returns as soon as
  // the callbacks are installed, and Firestore retries a network outage
  // silently rather than reporting it to the error callback, so a subscription
  // that never reaches the server looks exactly like one that has. setHealthy
  // is what says the data is actually arriving; the caller must keep its
  // fallback running until then.
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
      this.startedUid = session.uid;
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
    this.startedUid = undefined;
    // Demoting here, ahead of the awaits below, is the same trade fail() makes:
    // the fallback has to be told before the slow cleanup, not after it. The
    // baseline goes with it, so the next start rebuilds one from its own first
    // server snapshot instead of measuring against the previous account's.
    this.trayHealthy = false;
    this.noticesHealthy = false;
    this.baselined = false;
    this.delivered.clear();
    this.signalHealth();
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

  // Signals setHealthy only when the aggregate changes, and never lets a
  // throwing handler out: these run from snapshot callbacks dispatched by the
  // Firestore SDK's own timers, where an exception is an uncaught main-process
  // error rather than something a caller can catch.
  private signalHealth(): void {
    const healthy = this.trayHealthy && this.noticesHealthy;
    if (healthy === this.signalledHealthy) return;
    this.signalledHealthy = healthy;
    safeLog("listener-health", { healthy });
    try {
      this.handlers.setHealthy(healthy);
    } catch (handlerErr) {
      safeLog("listener-error", { at: "set-healthy", error: String(handlerErr) });
    }
  }

  // The fallback signal goes out before cleanup rather than after it: teardown
  // waits on releaseAuth(), which queues behind any in-flight restoreAuth()
  // with no timeout, and the app must not go that long without notifications.
  // The flag keeps one failure to one signal when both snapshots error at once.
  // stop() is called first, not after the handler: its enqueue is synchronous
  // and blocks on nothing, so the demotion still happens in the same turn with
  // nothing awaited before it, but registering first puts this teardown ahead
  // of any start() a synchronously-retrying handler enqueues.
  private fail(at: string, err: unknown): void {
    safeLog("listener-error", { at, error: String(err) });
    if (this.failed) return;
    this.failed = true;
    this.started = false;
    void this.stop();
    this.trayHealthy = false;
    this.noticesHealthy = false;
    this.signalHealth();
  }

  private watchTray(db: Firestore, uid: string): void {
    this.unsubs.push(
      onSnapshot(
        doc(db, "users", uid),
        LISTEN_OPTIONS,
        (snap) => {
          this.trayHealthy = !snap.metadata.fromCache;
          this.signalHealth();
          // A cache-only snapshot says nothing about the server. On a cache
          // miss the document reads as absent, the counts below collapse to
          // {}, and painting that would clear the badge to zero - telling the
          // user there is nothing unread at the moment the app is blind.
          if (snap.metadata.fromCache) return;
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
    const since = Timestamp.fromDate(new Date(Date.now() - OVERLAP_MS));
    this.unsubs.push(
      onSnapshot(
        query(collection(db, "users", uid, "notices"), where("created_at", ">", since)),
        LISTEN_OPTIONS,
        (snap) => {
          this.noticesHealthy = !snap.metadata.fromCache;
          this.signalHealth();
          // A cache snapshot replays documents the cache already held, so its
          // changes are no evidence that anything is new.
          if (snap.metadata.fromCache) return;
          // The first server snapshot is the baseline: it carries the overlap
          // window's backlog, which the user has already seen. Recording its
          // ids and firing nothing makes a quiet startup a property of this
          // set rather than of the workstation clock.
          if (!this.baselined) {
            this.baselined = true;
            for (const d of snap.docs) this.remember(d.id);
            safeLog("listener-baseline", { count: snap.docs.length });
            return;
          }
          const added: Notice[] = [];
          for (const change of snap.docChanges()) {
            if (change.type !== "added") continue;
            if (this.delivered.has(change.doc.id)) continue;
            this.remember(change.doc.id);
            added.push({ documentId: change.doc.id, ...change.doc.data() } as Notice);
          }
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

  // Set iteration is insertion-ordered, so the tail is the most recent half.
  private remember(id: string): void {
    this.delivered.add(id);
    if (this.delivered.size > SEEN_CAP) {
      this.delivered = new Set([...this.delivered].slice(-SEEN_KEEP));
    }
  }

  private notify(notices: Notice[]): void {
    if (!Notification.isSupported()) {
      safeLog("listener-notify-skip", { reason: "unsupported", count: notices.length });
      return;
    }
    const { fire, collapsed } = capNotices(notices);
    // Guarded per notice, not per batch: a Notification constructor throwing
    // on the second of five would otherwise drop the remaining three and the
    // collapsed toast along with it.
    const fired: string[] = [];
    for (const n of fire) {
      try {
        this.show(notificationTitle(n), noticeBody(n), noticeUrl(n));
        fired.push(n.type);
      } catch (err) {
        safeLog("listener-error", { at: "show", error: String(err) });
      }
    }
    if (collapsed > 0) {
      try {
        this.show("リベシティ", `他 ${collapsed} 件の通知があります`, undefined);
      } catch (err) {
        safeLog("listener-error", { at: "show-collapsed", error: String(err) });
      }
    }
    safeLog("listener-notify", { fired, collapsed });
  }

  private show(title: string, body: string, url?: string): void {
    const n = new Notification({ title, body });
    // Held until the notification is closed. A Notification that becomes
    // unreachable can be collected along with the native object behind it, and
    // the click then never arrives - which is invisible, because the toast
    // still looks and behaves normally right up until it is clicked.
    this.live.add(n);
    const release = () => this.live.delete(n);
    n.on("close", release);
    n.on("failed", release);
    n.on("click", () => {
      // Logged before anything can go wrong with it, so "the click never
      // arrived" and "the click arrived and had nowhere to go" stay
      // distinguishable in the log.
      safeLog("listener-click", { hasUrl: Boolean(url) });
      try {
        this.handlers.openUrl(url);
      } catch (err) {
        safeLog("listener-error", { at: "open-url", error: String(err) });
      }
    });
    n.show();
  }
}
