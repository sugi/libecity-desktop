// Runs in the preload (renderer) context, where the libecity.com-origin
// IndexedDB that the Firebase Auth SDK writes to is reachable.

import { API_KEY } from "./firebase-config";

const DB_NAME = "firebaseLocalStorageDb";
const STORE = "firebaseLocalStorage";
const KEY = `firebase:authUser:${API_KEY}:[DEFAULT]`;

export type ExtractedSession = {
  uid: string;
  email?: string;
  accessToken: string;
  refreshToken: string;
  expirationTime?: number;
};

type StoredAuthUser = {
  uid?: string;
  email?: string;
  stsTokenManager?: {
    accessToken?: string;
    refreshToken?: string;
    expirationTime?: number;
  };
};

const openDb = (): Promise<IDBDatabase | undefined> =>
  new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME);
    } catch {
      resolve(undefined);
      return;
    }
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(undefined);
    // The SDK already created it; if it doesn't exist yet, don't create schema.
    req.onupgradeneeded = () => {
      req.transaction?.abort();
      resolve(undefined);
    };
  });

// undefined: the row could not be read. null: the store was read and holds no entry.
const readEntry = (db: IDBDatabase): Promise<StoredAuthUser | null | undefined> =>
  new Promise((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, "readonly");
    } catch {
      resolve(undefined);
      return;
    }
    const get = tx.objectStore(STORE).get(KEY);
    get.onsuccess = () => {
      const row = get.result as { value?: StoredAuthUser } | StoredAuthUser | undefined;
      if (!row) return resolve(null);
      // firebase wraps the payload as { fbase_key, value }
      resolve((row as { value?: StoredAuthUser }).value ?? (row as StoredAuthUser));
    };
    get.onerror = () => resolve(undefined);
  });

export type SessionProbe =
  | { state: "session"; session: ExtractedSession }
  | { state: "signed-out" }
  | { state: "unknown" };

// "unknown" and "signed-out" have to be distinguishable: the SDK writes the
// entry some time after DOMContentLoaded, so an absent entry early in a page's
// life is not a sign-out, and treating it as one would drop a live session.
export async function extractSession(): Promise<SessionProbe> {
  const db = await openDb();
  if (!db) return { state: "unknown" };
  try {
    const entry = await readEntry(db);
    if (entry === undefined) return { state: "unknown" };
    if (entry === null) return { state: "signed-out" };
    const tm = entry.stsTokenManager;
    if (!entry.uid || !tm?.refreshToken) return { state: "signed-out" };
    return {
      state: "session",
      session: {
        uid: entry.uid,
        email: entry.email,
        accessToken: tm.accessToken ?? "",
        refreshToken: tm.refreshToken,
        expirationTime: tm.expirationTime,
      },
    };
  } finally {
    db.close();
  }
}
