import { record } from "./traffic-dump";

// Published by the site itself at https://libecity.com/swenv.js
const API_KEY = "AIzaSyDxUFU2BiEQ1By3EKL8DL6IxoWgzutmR18";
const PROJECT_ID = "production-b8884";

const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const SECURETOKEN = `https://securetoken.googleapis.com/v1/token?key=${API_KEY}`;

export type AuthSession = {
  uid: string;
  email?: string;
  accessToken: string;
  refreshToken: string;
  expirationTime?: number;
};

export type RefreshResult = {
  ok: boolean;
  status: number;
  idToken?: string;
  refreshToken?: string;
  expiresIn?: string;
  body?: unknown;
};

// Step 2: proves the main process can mint tokens without the webview.
export async function refreshIdToken(
  refreshToken: string
): Promise<RefreshResult> {
  const res = await fetch(SECURETOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const body = (await res.json().catch(() => undefined)) as
    | Record<string, string>
    | undefined;
  return {
    ok: res.ok,
    status: res.status,
    idToken: body?.id_token,
    refreshToken: body?.refresh_token,
    expiresIn: body?.expires_in,
    body,
  };
}

type ProbeSpec = { label: string; method: "GET" | "POST"; url: string };

// Step 3: what the user's own credentials can actually reach. listCollectionIds
// is the discovery call - it names subcollections without knowing them upfront.
const probeSpecs = (uid: string): ProbeSpec[] => [
  { label: "user-doc", method: "GET", url: `${FIRESTORE}/users/${uid}` },
  {
    label: "user-subcollections",
    method: "POST",
    url: `${FIRESTORE}/users/${uid}:listCollectionIds`,
  },
  {
    label: "user-rooms",
    method: "GET",
    url: `${FIRESTORE}/users/${uid}/user_rooms?pageSize=5`,
  },
  {
    label: "root-collections",
    method: "POST",
    url: `${FIRESTORE}:listCollectionIds`,
  },
];

export async function firestoreRequest(
  spec: ProbeSpec,
  idToken: string
): Promise<{ status: number; ok: boolean; body: unknown }> {
  const res = await fetch(spec.url, {
    method: spec.method,
    headers: {
      Authorization: `Bearer ${idToken}`,
      ...(spec.method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    ...(spec.method === "POST" ? { body: "{}" } : {}),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // leave as text
  }
  return { status: res.status, ok: res.ok, body };
}

export async function probeFirebase(session: AuthSession): Promise<void> {
  record("probe-start", { uid: session.uid, email: session.email });

  const refreshed = await refreshIdToken(session.refreshToken).catch((err) => {
    record("probe-error", { at: "refresh", error: String(err) });
    return undefined;
  });
  if (refreshed) record("token-refresh", refreshed);

  const idToken = refreshed?.idToken ?? session.accessToken;
  if (!idToken) {
    record("probe-abort", { reason: "no id token available" });
    return;
  }

  for (const spec of probeSpecs(session.uid)) {
    try {
      const result = await firestoreRequest(spec, idToken);
      record("probe", { label: spec.label, url: spec.url, ...result });
    } catch (err) {
      record("probe-error", { label: spec.label, error: String(err) });
    }
  }
  record("probe-done", { uid: session.uid });
}
