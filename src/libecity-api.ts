import { session as electronSession, type Session } from "electron";
import { refreshIdToken } from "./firebase-auth";
import { log } from "./log";

// A notification category as returned by city.notice.getCategories. One entry
// per bell category (message, dm, follow, live, ...).
export type NoticeCategory = {
  type: string;
  unread_count: number;
  is_display: boolean;
  last_read_timestamp?: string;
  last_created_at?: string;
  latest_notice_title?: string;
};

const PARTITION = "persist:libecity-daemon";
const AUTH_LOGIN = "https://libecity.com/auth/login";
// Replicates the exact query the web app sends (tRPC httpBatchLink, no input).
const GET_CATEGORIES =
  "https://api.libecity.com/city.notice.getCategories?batch=1&input=%7B%7D";

type TokenState = { idToken: string; refreshToken: string; expiresAt: number };

export class LibecityClient {
  private session: Session;
  private token?: TokenState;
  private loggedInFor?: string; // idToken the current cookie session belongs to

  constructor(private refreshToken: string) {
    this.session = electronSession.fromPartition(PARTITION);
  }

  updateRefreshToken(token: string): void {
    this.refreshToken = token;
    this.token = undefined;
    this.loggedInFor = undefined;
  }

  private async ensureIdToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAt - 60_000 > now) {
      return this.token.idToken;
    }
    const res = await refreshIdToken(this.refreshToken);
    if (!res.ok || !res.idToken) {
      throw new Error(`token refresh failed: status=${res.status}`);
    }
    if (res.refreshToken) this.refreshToken = res.refreshToken;
    const ttl = Number(res.expiresIn ?? "3600") * 1000;
    this.token = {
      idToken: res.idToken,
      refreshToken: this.refreshToken,
      expiresAt: now + ttl,
    };
    return res.idToken;
  }

  // Establishes the libecity.com session cookie from the Firebase ID token.
  private async ensureSession(idToken: string): Promise<void> {
    if (this.loggedInFor === idToken) return;
    const res = await this.session.fetch(AUTH_LOGIN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: idToken }),
    });
    const body = await res.text().catch(() => "");
    log("daemon-login", { status: res.status, ok: res.ok, body: body.slice(0, 200) });
    if (!res.ok) throw new Error(`auth/login failed: status=${res.status}`);
    this.loggedInFor = idToken;
  }

  async getCategories(): Promise<NoticeCategory[]> {
    const idToken = await this.ensureIdToken();
    await this.ensureSession(idToken);

    const fetchOnce = () =>
      this.session.fetch(GET_CATEGORIES, {
        method: "GET",
        headers: {
          // cookie carries the session; Bearer is a harmless fallback in case
          // the endpoint is token- rather than cookie-authenticated.
          Authorization: `Bearer ${idToken}`,
          "Content-Type": "application/json",
        },
      });

    let res = await fetchOnce();
    if (res.status === 401 || res.status === 403) {
      // stale cookie: force a fresh login and retry once
      this.loggedInFor = undefined;
      await this.ensureSession(idToken);
      res = await fetchOnce();
    }

    const text = await res.text();
    if (!res.ok) {
      log("daemon-categories-error", { status: res.status, body: text.slice(0, 300) });
      throw new Error(`getCategories failed: status=${res.status}`);
    }

    const categories = parseCategories(text);
    log("daemon-categories", {
      status: res.status,
      summary: categories.map((c) => ({
        type: c.type,
        unread: c.unread_count,
        last_created_at: c.last_created_at,
      })),
    });
    return categories;
  }
}

export function parseCategories(body: string): NoticeCategory[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  // tRPC batch response: [{ result: { data: { categories: [...] } } }]
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  const data = (first as { result?: { data?: { categories?: unknown } } })?.result?.data;
  const categories = data?.categories;
  if (!Array.isArray(categories)) return [];
  return categories.filter(
    (c): c is NoticeCategory => typeof c === "object" && c !== null && "type" in c
  );
}
