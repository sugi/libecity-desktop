import { deleteApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { initializeAuth, type Persistence } from "firebase/auth";
import { refreshIdToken } from "./firebase-auth";
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
function seededPersistence(key: string, blob: unknown) {
  const store = new Map<string, unknown>([[key, blob]]);
  class SeededPersistence {
    readonly type = "LOCAL";
    async _isAvailable() {
      return true;
    }
    async _set(k: string, v: unknown) {
      store.set(k, v);
    }
    async _get(k: string) {
      return store.get(k) ?? null;
    }
    async _remove(k: string) {
      store.delete(k);
    }
    _addListener() {}
    _removeListener() {}
  }
  return SeededPersistence as unknown as Persistence;
}

export async function releaseAuth(): Promise<void> {
  for (const app of getApps()) {
    await deleteApp(app).catch(() => undefined);
  }
}

export async function restoreAuth(
  refreshToken: string
): Promise<FirebaseSession | undefined> {
  const refreshed = await refreshIdToken(refreshToken).catch((err) => {
    log("listener-auth-error", { at: "refresh", error: String(err) });
    return undefined;
  });
  const uid = (refreshed?.body as Record<string, string> | undefined)?.user_id;
  if (!refreshed?.ok || !refreshed.idToken || !uid) {
    log("listener-auth-error", { at: "refresh", status: refreshed?.status });
    return undefined;
  }

  await releaseAuth();

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
      persistence: seededPersistence(`firebase:authUser:${API_KEY}:[DEFAULT]`, blob),
    });
    await auth.authStateReady();
    if (auth.currentUser?.uid !== uid) {
      log("listener-auth-error", { at: "restore", currentUser: auth.currentUser?.uid ?? null });
      await releaseAuth();
      return undefined;
    }
    log("listener-auth", { uid });
    return { app, uid };
  } catch (err) {
    log("listener-auth-error", { at: "initialize", error: String(err) });
    await releaseAuth();
    return undefined;
  }
}
