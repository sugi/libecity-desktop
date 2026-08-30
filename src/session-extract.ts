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

const readEntry = (db: IDBDatabase): Promise<StoredAuthUser | undefined> =>
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
      if (!row) return resolve(undefined);
      // firebase wraps the payload as { fbase_key, value }
      const value = (row as { value?: StoredAuthUser }).value ?? (row as StoredAuthUser);
      resolve(value);
    };
    get.onerror = () => resolve(undefined);
  });

export async function extractSession(): Promise<ExtractedSession | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  try {
    const entry = await readEntry(db);
    const tm = entry?.stsTokenManager;
    if (!entry?.uid || !tm?.refreshToken) return undefined;
    return {
      uid: entry.uid,
      email: entry.email,
      accessToken: tm.accessToken ?? "",
      refreshToken: tm.refreshToken,
      expirationTime: tm.expirationTime,
    };
  } finally {
    db.close();
  }
}
