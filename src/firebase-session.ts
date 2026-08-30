import { deleteApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { initializeAuth, type Persistence } from "firebase/auth";
import { refreshIdToken, type RefreshResult } from "./firebase-auth";
import { log } from "./log";

// Published by the site itself at https://libecity.com/swenv.js
const API_KEY = "AIzaSyDxUFU2BiEQ1By3EKL8DL6IxoWgzutmR18";
const PROJECT_ID = "production-b8884";

export type FirebaseSession = { app: FirebaseApp; uid: string };

// The SDK has no public "sign in with a refresh token", so it gets handed the
// blob it would have written itself and takes over from there. Two things this
// depends on, both verified by scripts/listen-probe.cjs: initializeAuth
// instantiates what it is given, so this must be a class and not an object;
// and the seeded accessToken is checked against accounts:lookup during
// restore, so it has to be freshly minted.
//
// The SDK also caches persistence instances in a module-level map keyed by
// the class object, with no eviction hook -- deleteApp does not touch it. A
// fresh class per call would pin one more cached instance (and the tokens
// its closure holds) on every restore, for the life of the process. Instead
// there is exactly one class, reading a module-level store that restoreAuth
// re-seeds and releaseAuth clears, so exactly one entry is ever cached.
const seededStore = new Map<string, unknown>();

class SeededPersistence {
  readonly type = "LOCAL";
  async _isAvailable() {
    return true;
  }
  async _set(k: string, v: unknown) {
    seededStore.set(k, v);
  }
  async _get(k: string) {
    return seededStore.get(k) ?? null;
  }
  async _remove(k: string) {
    seededStore.delete(k);
  }
  _addListener() {}
  _removeListener() {}
}

function seedPersistence(key: string, blob: unknown): Persistence {
  seededStore.clear();
  seededStore.set(key, blob);
  return SeededPersistence as unknown as Persistence;
}

function refreshErrorReason(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const error = (body as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" ? message : undefined;
}

async function releaseAuthImpl(): Promise<void> {
  for (const app of getApps()) {
    await deleteApp(app).catch(() => undefined);
  }
  seededStore.clear();
}

async function restoreAuthImpl(
  refreshToken: string
): Promise<FirebaseSession | undefined> {
  let refreshed: RefreshResult;
  try {
    refreshed = await refreshIdToken(refreshToken);
  } catch (err) {
    log("listener-auth-error", { at: "refresh", error: String(err) });
    return undefined;
  }

  const uid = (refreshed.body as Record<string, string> | undefined)?.user_id;
  if (!refreshed.ok || !refreshed.idToken || !uid) {
    log("listener-auth-error", {
      at: "refresh",
      status: refreshed.status,
      reason: refreshErrorReason(refreshed.body),
    });
    return undefined;
  }

  await releaseAuthImpl();

  const now = Date.now();
  const blob = {
    uid,
    email: null,
    emailVerified: true,
    displayName: null,
    isAnonymous: false,
    photoURL: null,
    providerData: [],
    stsTokenManager: {
      refreshToken: refreshed.refreshToken ?? refreshToken,
      accessToken: refreshed.idToken,
      expirationTime: now + Number(refreshed.expiresIn ?? "3600") * 1000,
    },
    createdAt: String(now),
    lastLoginAt: String(now),
    apiKey: API_KEY,
    appName: "[DEFAULT]",
  };

  try {
    const app = initializeApp({
      apiKey: API_KEY,
      authDomain: `${PROJECT_ID}.firebaseapp.com`,
      projectId: PROJECT_ID,
    });
    const auth = initializeAuth(app, {
      persistence: seedPersistence(`firebase:authUser:${API_KEY}:[DEFAULT]`, blob),
    });
    await auth.authStateReady();
    if (auth.currentUser?.uid !== uid) {
      log("listener-auth-error", { at: "restore", currentUser: auth.currentUser?.uid ?? null });
      await releaseAuthImpl();
      return undefined;
    }
    log("listener-auth", { uid });
    return { app, uid };
  } catch (err) {
    log("listener-auth-error", { at: "initialize", error: String(err) });
    await releaseAuthImpl();
    return undefined;
  }
}

// restoreAuth and releaseAuth must never run interleaved: if releaseAuth
// deletes the app while a restoreAuth is awaiting authStateReady() on it,
// the SDK marks the app deleted mid-initialization and that promise never
// settles in either direction -- the caller waiting on restoreAuth would
// hang forever instead of getting the undefined fallback signal. Both
// entry points funnel through this single queue so a call only starts once
// every call ahead of it has fully finished; a releaseAuth that arrives
// while a restoreAuth is in flight simply waits its turn and then releases,
// which is the correct outcome.
let queue: Promise<void> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export function releaseAuth(): Promise<void> {
  return enqueue(releaseAuthImpl);
}

export function restoreAuth(
  refreshToken: string
): Promise<FirebaseSession | undefined> {
  return enqueue(() => restoreAuthImpl(refreshToken));
}
