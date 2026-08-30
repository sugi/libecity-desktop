import { API_KEY } from "./firebase-config";

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

// Lets the main process mint an ID token from a stored refresh token, so the
// notification daemon can poll with no window open.
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
