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
  "auth",
  "sessionid",
  "sessiontoken",
  "password",
  "secret",
]);

// Not credentials, but the dump is handed to people. analyze-dump.mjs already
// masks these before a report is shared; the raw capture needs the same.
const PII_KEYS = new Set([
  "email",
  "phonenumber",
  "accountnumber",
  "accountname",
  "bankcode",
  "bankname",
  "branchcode",
  "branchname",
  "address",
  "postalcode",
  "birthday",
  "passwordhash",
  "salt",
  "rawid",
  "federatedid",
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
  /([?&](?:auth|access_token|id_token|refresh_token|token|gsessionid|sid|snid|session)=)[^&\s"']+/gi;
// Refresh tokens, FCM registration ids and API keys are opaque rather than
// structured, so length is the only thing that gives them away in a body.
const OPAQUE = /[A-Za-z0-9_-]{80,}/g;

const scrub = (s: string): string =>
  s
    .replace(JWT, "<jwt redacted>")
    .replace(AUTH_SCHEME, (_m, scheme: string) => `${scheme} <redacted>`)
    .replace(JSON_SECRET, (_m, head: string) => `${head}"<redacted>"`)
    .replace(URL_SECRET, (_m, head: string) => `${head}<redacted>`)
    // Last, so the rules above get first refusal on anything they name better.
    .replace(OPAQUE, (m) => `<blob:${m.length}>`);

// Keeping the length tells you a token really was present and roughly how big,
// which is most of what the dump is consulted for.
const mask = (v: unknown) =>
  typeof v === "string" ? `<redacted len=${v.length}>` : "<redacted>";

const walk = (value: unknown, depth: number): unknown => {
  // Deeper than anything the API returns: past here we can no longer promise a
  // scrub, so mask rather than hand the value through.
  if (depth > 12) return mask(value);
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const key = norm(k);
      out[k] = SECRET_KEYS.has(key) || PII_KEYS.has(key) ? mask(v) : walk(v, depth + 1);
    }
    return out;
  }
  return value;
};

export function redact(value: unknown): unknown {
  return walk(value, 0);
}
