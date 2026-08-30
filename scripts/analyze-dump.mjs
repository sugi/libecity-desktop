#!/usr/bin/env node
// Turn a raw API dump (dump/session-*.jsonl) into a readable, secret-redacted
// report for finding useful endpoints. Reads full bodies - unlike the tsv
// summary, which throws them away.
//
//   node scripts/analyze-dump.mjs <dump.jsonl> [more.jsonl ...] > report.txt
//
// The report is safe to share: tokens, Authorization headers, cookies and
// long opaque blobs are replaced with placeholders. Field NAMES and small
// values are kept, which is what we need to locate unread/notification data.

import * as fs from "fs";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: node scripts/analyze-dump.mjs <dump.jsonl> [...]");
  process.exit(1);
}

const MAX_SAMPLE = 4000; // chars of a single body printed in a sample

// ---- redaction -----------------------------------------------------------

const JWT = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
const SECRET_KEYS =
  /^(authorization|cookie|set-cookie|x-goog-api-key|access_?token|id_?token|refresh_?token|idtoken|accesstoken|refreshtoken|apikey|api_key|auth|sessionid)$/i;
// Real personal data the API legitimately returns - not a credential, but must
// not land in a shareable report.
const PII_KEYS =
  /^(email|federatedid|phone_?number|phonenumber|rawid|passwordhash|salt|account_?number|account_?name|branch_?code|branch_?name|bank_?code|bank_?name|address|postal_?code|birthday)$/i;

const SECRET_QUERY = /([?&](?:gsessionid|sid|snid|access_token|auth|token|session|zx|t)=)[^&\s"]+/gi;

const redactString = (s) => {
  if (typeof s !== "string") return s;
  let out = s.replace(JWT, "<jwt>");
  // long opaque base64url / hex blobs (tokens, keys, FCM registration ids)
  out = out.replace(/[A-Za-z0-9_-]{80,}/g, (m) => `<blob:${m.length}>`);
  // sensitive query params by name, regardless of length
  out = out.replace(SECRET_QUERY, "$1<redacted>");
  // securetoken / identitytoolkit ?key=... is a public value, keep it short
  out = out.replace(/([?&]key=)[A-Za-z0-9_-]+/g, "$1<apikey>");
  return out;
};

const isSensitiveKey = (k) => SECRET_KEYS.test(k) || PII_KEYS.test(k);

const redact = (val, keyHint = "") => {
  if (val === null || val === undefined) return val;
  if (typeof val === "string") {
    if (isSensitiveKey(keyHint)) return "<redacted>";
    return redactString(val);
  }
  if (Array.isArray(val)) return val.map((v) => redact(v, keyHint));
  if (typeof val === "object") {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = isSensitiveKey(k) ? "<redacted>" : redact(v, k);
    }
    return out;
  }
  return val;
};

// ---- Firestore helpers ---------------------------------------------------

// Flatten Firestore's typed value form ({stringValue:"x"}, {integerValue:"3"},
// {mapValue:{fields:{...}}}) into plain JSON so field names/values read cleanly.
const flattenFsValue = (v) => {
  if (v == null || typeof v !== "object") return v;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("referenceValue" in v) return `ref:${v.referenceValue}`;
  if ("geoPointValue" in v) return v.geoPointValue;
  if ("bytesValue" in v) return "<bytes>";
  if ("arrayValue" in v)
    return (v.arrayValue.values ?? []).map(flattenFsValue);
  if ("mapValue" in v) return flattenFsFields(v.mapValue.fields ?? {});
  return v;
};
const flattenFsFields = (fields) => {
  const out = {};
  for (const [k, val] of Object.entries(fields ?? {})) out[k] = flattenFsValue(val);
  return out;
};

const shortPath = (name) =>
  typeof name === "string"
    ? name.replace(/^projects\/[^/]+\/databases\/\(default\)\/documents\//, "")
    : name;

// Firestore's realtime channel (and some batchGet responses) are a stream of
// length-prefixed JSON chunks: "<decimal>\n<json><decimal>\n<json>...".
// Chromium serves Listen over HTTP long-poll, so this lands in `http` bodies,
// not `ws-*`. Recover every JSON value we can from such a body.
const extractJsonChunks = (body) => {
  const out = [];
  if (typeof body !== "string") return out;
  const whole = tryParse(body);
  if (whole !== undefined) return [whole];
  // length-prefixed framing
  let i = 0;
  while (i < body.length) {
    const m = /^(\d+)\n/.exec(body.slice(i));
    if (!m) break;
    const len = Number(m[1]);
    const start = i + m[0].length;
    const chunk = body.slice(start, start + len);
    const parsed = tryParse(chunk);
    if (parsed !== undefined) out.push(parsed);
    i = start + len;
  }
  if (out.length) return out;
  // last resort: pull out balanced {...} objects that mention a document name
  for (const obj of scanBracedObjects(body)) {
    const parsed = tryParse(obj);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
};

const tryParse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

function* scanBracedObjects(s) {
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        yield s.slice(start, i + 1);
        start = -1;
      }
    }
  }
}

// All Firestore document paths seen anywhere (even when fields don't parse).
const collectFsPaths = (body, out) => {
  if (typeof body !== "string") return;
  const re =
    /projects\/[^/]+\/databases\/\(default\)\/documents\/([A-Za-z0-9_%./-]+?)(?=["\\])/g;
  let m;
  while ((m = re.exec(body))) out.add(shortPath(`projects/x/databases/(default)/documents/${m[1]}`));
};

// Collect every Firestore document {path, fields} found anywhere in an object.
const collectFsDocs = (node, out) => {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) collectFsDocs(n, out);
    return;
  }
  if (typeof node.name === "string" && node.fields && typeof node.fields === "object") {
    out.push({ path: shortPath(node.name), fields: flattenFsFields(node.fields) });
  }
  for (const v of Object.values(node)) collectFsDocs(v, out);
};

// ---- path templating (group by endpoint) ---------------------------------

const templatePath = (url) => {
  let u;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const path = u.pathname
    .split("/")
    .map((seg) => {
      if (/^\d+$/.test(seg)) return "{n}";
      if (/^[A-Za-z0-9_-]{20,}$/.test(seg)) return "{id}";
      return seg;
    })
    .join("/");
  return `${u.host}${path}`;
};

// ---- read records --------------------------------------------------------

const records = [];
for (const f of files) {
  const text = fs.readFileSync(f, "utf8");
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      records.push(JSON.parse(s));
    } catch {
      // skip malformed line
    }
  }
}

// ---- 1. endpoint inventory ----------------------------------------------

const endpoints = new Map(); // key -> {method, template, count, statuses:Set}
const bump = (method, url, status) => {
  const template = templatePath(url);
  const key = `${method} ${template}`;
  let e = endpoints.get(key);
  if (!e) {
    e = { method, template, count: 0, statuses: new Set() };
    endpoints.set(key, e);
  }
  e.count++;
  if (status != null) e.statuses.add(status);
};

for (const r of records) {
  if (r.kind === "http" || r.kind === "http-failed") {
    bump(r.data.method ?? "?", r.data.url ?? "?", r.data.status);
  } else if (r.kind === "probe") {
    bump("PROBE", r.data.url ?? "?", r.data.status);
  }
}

// ---- 2. one redacted sample per endpoint --------------------------------

const bodyText = (resp) => {
  if (!resp) return undefined;
  if (typeof resp.body === "string") return resp.body;
  if (resp.base64) return `<base64 ${resp.length} chars>`;
  if (resp.unavailable) return `<unavailable: ${resp.unavailable}>`;
  return undefined;
};

const sampleFor = new Map(); // endpoint key -> sample record
for (const r of records) {
  let method, url, status, postData, body;
  if (r.kind === "http") {
    ({ method, url, status, postData } = r.data);
    body = bodyText(r.data.response);
  } else if (r.kind === "probe") {
    method = "PROBE";
    url = r.data.url;
    status = r.data.status;
    body = typeof r.data.body === "string" ? r.data.body : JSON.stringify(r.data.body);
  } else {
    continue;
  }
  const key = `${method} ${templatePath(url)}`;
  // prefer a 2xx sample with a body
  const existing = sampleFor.get(key);
  const good = status && status < 300 && body;
  if (!existing || (good && !existing._good)) {
    sampleFor.set(key, { method, url, status, postData, body, _good: good });
  }
}

// ---- 3. Firestore documents & field key index ---------------------------

const fsDocs = [];
const fsPaths = new Set();
for (const r of records) {
  if (r.kind === "http" && /firestore\.googleapis\.com/.test(r.data.url ?? "")) {
    const body = bodyText(r.data.response);
    if (body) {
      for (const chunk of extractJsonChunks(body)) collectFsDocs(chunk, fsDocs);
      collectFsPaths(body, fsPaths);
    }
  } else if (r.kind === "probe" && r.data.body && typeof r.data.body === "object") {
    collectFsDocs(r.data.body, fsDocs);
    collectFsPaths(JSON.stringify(r.data.body), fsPaths);
  } else if (r.kind === "ws-recv" && typeof r.data.payload === "string") {
    for (const chunk of extractJsonChunks(r.data.payload)) collectFsDocs(chunk, fsDocs);
    collectFsPaths(r.data.payload, fsPaths);
  }
}
for (const d of fsDocs) fsPaths.add(d.path);

const fieldIndex = new Map(); // fieldName -> Set(doc path prefix)
const pathPrefix = (p) => (p ?? "").split("/").filter((_, i) => i % 2 === 0).join("/");
for (const d of fsDocs) {
  for (const k of Object.keys(d.fields ?? {})) {
    if (!fieldIndex.has(k)) fieldIndex.set(k, new Set());
    fieldIndex.get(k).add(pathPrefix(d.path));
  }
}

// ---- output --------------------------------------------------------------

const line = (s = "") => process.stdout.write(s + "\n");
const trunc = (s, n = MAX_SAMPLE) =>
  s && s.length > n ? s.slice(0, n) + `\n… (+${s.length - n} chars)` : s;

line("#".repeat(72));
line(`# API DUMP ANALYSIS  (${records.length} records from ${files.length} file(s))`);
line("#".repeat(72));

line("\n\n== 1. ENDPOINT INVENTORY ==\n");
const sorted = [...endpoints.values()].sort(
  (a, b) => a.template.localeCompare(b.template) || a.method.localeCompare(b.method)
);
for (const e of sorted) {
  line(
    `${String(e.count).padStart(4)}x  ${e.method.padEnd(6)} ${e.template}` +
      `   [${[...e.statuses].sort().join(",") || "-"}]`
  );
}

line("\n\n== 2. Firestore / WebSocket presence ==\n");
const wsOpens = records.filter((r) => r.kind === "ws-open");
const wsRecv = records.filter((r) => r.kind === "ws-recv").length;
const wsSend = records.filter((r) => r.kind === "ws-send").length;
line(`WebSocket connections opened: ${wsOpens.length}`);
for (const w of wsOpens) line(`  ${redactString(w.data.url)}`);
line(`WebSocket frames: ${wsSend} sent / ${wsRecv} received`);
const tokenRefresh = records.find((r) => r.kind === "token-refresh");
if (tokenRefresh)
  line(
    `\ntoken-refresh: status=${tokenRefresh.data.status} ok=${tokenRefresh.data.ok} ` +
      `gotIdToken=${Boolean(tokenRefresh.data.idToken)}`
  );

line("\n\n== 3. Firestore DOCUMENT PATHS observed (templated) ==\n");
const templatedFsPaths = new Map(); // template -> count
for (const p of fsPaths) {
  const t = p
    .split("/")
    .map((seg, i) => (i % 2 === 1 && /^[A-Za-z0-9_-]{6,}$/.test(seg) ? "{id}" : seg))
    .join("/");
  templatedFsPaths.set(t, (templatedFsPaths.get(t) ?? 0) + 1);
}
for (const [t, n] of [...templatedFsPaths.entries()].sort())
  line(`${String(n).padStart(4)}x  ${t}`);

line("\n\n== 4. Firestore FIELD INDEX (field -> collections it appears in) ==\n");
const keys = [...fieldIndex.keys()].sort();
for (const k of keys) {
  line(`${k.padEnd(28)} ${[...fieldIndex.get(k)].join(", ")}`);
}
line(`\n(${fsDocs.length} Firestore documents observed across ${new Set(fsDocs.map((d) => pathPrefix(d.path))).size} collections)`);

line("\n\n== 5. Firestore DOCUMENT SAMPLES (one per collection) ==\n");
const perCollection = new Map();
for (const d of fsDocs) {
  const c = pathPrefix(d.path);
  if (!perCollection.has(c)) perCollection.set(c, d);
}
for (const [c, d] of perCollection) {
  line(`--- ${c} ---   (${d.path})`);
  line(trunc(JSON.stringify(redact(d.fields), null, 2), 1500));
  line("");
}

line("\n== 6. ENDPOINT SAMPLES (redacted request/response) ==\n");
for (const e of sorted) {
  const key = `${e.method} ${e.template}`;
  const s = sampleFor.get(key);
  if (!s) continue;
  line("-".repeat(60));
  line(`${s.method} ${redactString(s.url)}   -> ${s.status ?? "?"}`);
  if (s.postData) line(`  request body: ${trunc(redactString(s.postData), 800)}`);
  if (s.body) line(`  response:\n${trunc(redactBody(s.body), 2000)}`);
  line("");
}

// Redact PII/secret keys inside a body string. Firestore bodies (chunked or
// typed-value) go through the chunk extractor + flattener; plain JSON is
// parsed and key-redacted; anything else falls back to string redaction.
function redactBody(body) {
  const chunks = extractJsonChunks(body);
  if (chunks.length) {
    return chunks
      .map((c) => JSON.stringify(redact(deepFlattenFs(c)), null, 2))
      .join("\n");
  }
  return redactString(body);
}

// If a value looks like a Firestore document ({name, fields}), flatten it.
function deepFlattenFs(node) {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(deepFlattenFs);
  if (typeof node.name === "string" && node.fields && typeof node.fields === "object") {
    return { name: shortPath(node.name), fields: flattenFsFields(node.fields) };
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = deepFlattenFs(v);
  return out;
}
