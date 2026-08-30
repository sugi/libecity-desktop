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

  constructor(private handlers: ListenerHandlers) {}

  get running(): boolean {
    return this.started;
  }

  async start(refreshToken: string): Promise<boolean> {
    await this.stop();
    const session = await restoreAuth(refreshToken);
    if (!session) return false;

    try {
      const db = getFirestore(session.app);
      this.db = db;
      this.watchTray(db, session.uid);
      this.watchNotices(db, session.uid);
      this.started = true;
      log("listener-start", { uid: session.uid });
      return true;
    } catch (err) {
      log("listener-error", { at: "start", error: String(err) });
      await this.stop();
      return false;
    }
  }

  async stop(): Promise<void> {
    for (const unsub of this.unsubs) {
      try {
        unsub();
      } catch {
        // already gone
      }
    }
    this.unsubs = [];
    this.started = false;
    if (this.db) {
      await terminate(this.db).catch(() => undefined);
      this.db = undefined;
    }
    await releaseAuth();
  }

  private fail(at: string, err: unknown): void {
    log("listener-error", { at, error: String(err) });
    void this.stop().then(() => this.handlers.onFailure());
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
    if (!Notification.isSupported()) return;
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
