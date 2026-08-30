import { deleteApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { initializeAuth, type Persistence } from "firebase/auth";
import { refreshIdToken, type RefreshResult } from "./firebase-auth";
import { API_KEY, PROJECT_ID } from "./firebase-config";
import { log } from "./log";
import { clearSeeded, seedPersistence } from "./seeded-persistence";

export type FirebaseSession = { app: FirebaseApp; uid: string };

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
    // log() can throw (EPIPE, a dump file closed under it); that must not
    // reject this catch handler and skip clearing the seeded store / the
    // rest of this loop.
    await deleteApp(app).catch((err) => {
      try {
        log("listener-auth-error", { at: "delete-app", error: String(err) });
      } catch {
        // Diagnostics are best-effort here too.
      }
    });
  }
  clearSeeded();
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
      persistence: seedPersistence(
        `firebase:authUser:${API_KEY}:[DEFAULT]`,
        blob
      ) as Persistence,
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
