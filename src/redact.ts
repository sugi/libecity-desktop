// Best-effort credential scrubbing for anything written to the dump or the
// console. This does not make a capture safe to publish - bodies still carry
// chat content and account data - but it keeps live tokens out of a file that
// might end up attached to a bug report.

const norm = (key: string) => key.toLowerCase().replace(/[-_]/g, "");

const SECRET_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "xfirebaseappcheck",
  "token",
  "idtoken",
  "accesstoken",
  "refreshtoken",
  "authtoken",
  "sessiontoken",
  "password",
  "secret",
]);

const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi;
// Firebase refresh tokens are opaque rather than JWTs, so inside a body string
// the field name is the only thing that gives them away.
const JSON_SECRET =
  /("(?:[A-Za-z]*_?token|auth|cookie|authorization)"\s*:\s*)"(?:\\.|[^"\\])*"/gi;
// gsessionid identifies a live Firestore WebChannel, so it is as good as a
// credential for as long as the channel is open. The Firebase API key is
// public (the site serves it in swenv.js), so it is deliberately left alone.
const URL_SECRET =
  /([?&](?:auth|access_token|id_token|refresh_token|token|gsessionid)=)[^&\s"']+/gi;

const scrub = (s: string): string =>
  s
    .replace(JWT, "<jwt redacted>")
    .replace(AUTH_SCHEME, (_m, scheme: string) => `${scheme} <redacted>`)
    .replace(JSON_SECRET, (_m, head: string) => `${head}"<redacted>"`)
    .replace(URL_SECRET, (_m, head: string) => `${head}<redacted>`);

// Keeping the length tells you a token really was present and roughly how big,
// which is most of what the dump is consulted for.
const mask = (v: unknown) =>
  typeof v === "string" ? `<redacted len=${v.length}>` : "<redacted>";

const walk = (value: unknown, depth: number): unknown => {
  if (depth > 12) return value;
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.has(norm(k)) ? mask(v) : walk(v, depth + 1);
    }
    return out;
  }
  return value;
};

export function redact(value: unknown): unknown {
  return walk(value, 0);
}
