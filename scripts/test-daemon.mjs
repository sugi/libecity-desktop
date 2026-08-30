#!/usr/bin/env node
// Bundles the real daemon modules with `electron` stubbed out, then asserts the
// pure decision logic (tray state, tRPC parsing, new-item seeding/diff).
// Run: node scripts/test-daemon.mjs

import * as esbuild from "esbuild";
import { pathToFileURL } from "url";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const stub = `
export const Notification = class {};
export const session = { fromPartition: () => ({ fetch: async () => ({}) }) };
export const safeStorage = { isEncryptionAvailable: () => false };
export const app = { getPath: () => "." };
export default {};
`;

const outfile = path.join(os.tmpdir(), `daemon-test-${process.pid}.mjs`);
await esbuild.build({
  stdin: {
    contents: `
      export { computeState, diffNotifications, unreadTotal } from "./src/notification-daemon.ts";
      export { parseCategories } from "./src/libecity-api.ts";
      export { badgeText, drawBadge } from "./src/tray-badge.ts";
      export { redact } from "./src/redact.ts";
    `,
    resolveDir: ".",
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  plugins: [
    {
      name: "stub-electron",
      setup(build) {
        build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: stub, loader: "js" }));
      },
    },
  ],
});

const mod = await import(pathToFileURL(outfile).href);
const { computeState, diffNotifications, unreadTotal, parseCategories, badgeText, drawBadge, redact } =
  mod;

let failures = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failures++;
    console.error(`FAIL ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
  } else {
    console.log(`ok   ${name}`);
  }
};

const cat = (type, unread, at, is_display = true) => ({
  type,
  unread_count: unread,
  is_display,
  last_created_at: at,
  latest_notice_title: `${type}!`,
});

// --- computeState ---
eq("state: all zero -> default", computeState([cat("message", 0, "t1"), cat("dm", 0, "t1")]), "default");
eq("state: message unread -> message", computeState([cat("message", 2, "t1"), cat("dm", 0, "t1")]), "message");
eq("state: notice unread -> notice", computeState([cat("message", 0, "t1"), cat("dm", 1, "t1")]), "notice");
eq("state: notice outranks message", computeState([cat("message", 5, "t1"), cat("live", 1, "t1")]), "notice");
eq("state: hidden category ignored", computeState([cat("event", 3, "t1", false)]), "default");

// --- parseCategories ---
const trpc = JSON.stringify([
  { result: { data: { categories: [cat("message", 1, "t9"), cat("live", 1, "t9")] } } },
]);
eq("parse: tRPC batch length", parseCategories(trpc).length, 2);
eq("parse: tRPC first type", parseCategories(trpc)[0].type, "message");
eq("parse: garbage -> []", parseCategories("not json"), []);
eq("parse: empty batch -> []", parseCategories("[]"), []);

// --- diffNotifications (seeding + advance) ---
const seen = new Map();
eq("diff: first poll seeds, no fire", diffNotifications(seen, [cat("message", 1, "2026-01-01")], false).map((c) => c.type), []);
eq("diff: seeded baseline recorded", seen.get("message"), "2026-01-01");
eq("diff: no advance -> no fire", diffNotifications(seen, [cat("message", 1, "2026-01-01")], true).map((c) => c.type), []);
eq("diff: advance -> fire", diffNotifications(seen, [cat("message", 1, "2026-01-02")], true).map((c) => c.type), ["message"]);
eq("diff: advance but zero unread -> no fire", diffNotifications(seen, [cat("message", 0, "2026-01-03")], true).map((c) => c.type), []);
const seen2 = new Map();
diffNotifications(seen2, [cat("dm", 1, "2026-01-01", false)], false);
eq("diff: hidden category never fires", diffNotifications(seen2, [cat("dm", 5, "2026-01-09", false)], true).map((c) => c.type), []);
// a brand-new category type appearing after seed should NOT fire (no prev baseline)
const seen3 = new Map([["message", "2026-01-01"]]);
eq("diff: unseen type after seed -> no fire", diffNotifications(seen3, [cat("follow", 1, "2026-05-05")], true).map((c) => c.type), []);

// --- unreadTotal ---
eq("total: empty -> 0", unreadTotal([]), 0);
eq("total: sums across categories", unreadTotal([cat("message", 2, "t1"), cat("dm", 3, "t1")]), 5);
eq("total: hidden category ignored", unreadTotal([cat("message", 2, "t1"), cat("event", 9, "t1", false)]), 2);
eq("total: all read -> 0", unreadTotal([cat("message", 0, "t1")]), 0);

// --- badgeText ---
eq("text: zero -> nothing", badgeText(0), undefined);
eq("text: negative -> nothing", badgeText(-3), undefined);
eq("text: one digit", badgeText(1), "1");
eq("text: nine", badgeText(9), "9");
eq("text: ten overflows", badgeText(10), "9+");
eq("text: huge overflows", badgeText(1234), "9+");

// --- drawBadge ---
const W = 70, H = 70;
const STYLE = { width: W, height: H, centerX: 48, centerY: 48, radius: 19, color: [255, 255, 255] };
// nativeImage.toBitmap() hands back BGRA; navy #3B485E is the icons' background.
const bitmap = () => {
  const buf = Buffer.alloc(W * H * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 94; buf[i + 1] = 72; buf[i + 2] = 59; buf[i + 3] = 255;
  }
  return buf;
};
const changed = (before, after) => {
  const out = [];
  for (let i = 0; i < before.length; i += 4) {
    if (before[i] !== after[i] || before[i + 1] !== after[i + 1] || before[i + 2] !== after[i + 2]) {
      out.push([(i / 4) % W, Math.floor(i / 4 / W)]);
    }
  }
  return out;
};
const spanX = (pts) => Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0]));

const base = bitmap();
const drawn = drawBadge(base, "9", STYLE);
eq("draw: leaves the input buffer alone", base.equals(bitmap()), true);
const pts = changed(base, drawn);
eq("draw: paints something", pts.length > 0, true);
eq(
  "draw: every painted pixel is inside the dot",
  pts.every(([x, y]) => Math.hypot(x - STYLE.centerX, y - STYLE.centerY) <= STYLE.radius),
  true
);
eq(
  "draw: paints in the requested colour",
  pts.every(([x, y]) => {
    const o = (y * W + x) * 4;
    return drawn[o] === 255 && drawn[o + 1] === 255 && drawn[o + 2] === 255 && drawn[o + 3] === 255;
  }),
  true
);
eq(
  "draw: honours a different colour",
  (() => {
    const navy = drawBadge(bitmap(), "9", { ...STYLE, color: [59, 72, 94] });
    return changed(bitmap(), navy).length;
  })(),
  0 // navy on navy is invisible: same colour in, no pixel differs
);
const one = changed(bitmap(), drawBadge(bitmap(), "1", STYLE));
const eight = changed(bitmap(), drawBadge(bitmap(), "8", STYLE));
eq("draw: glyphs differ (1 is thinner than 8)", one.length < eight.length, true);
eq("draw: two glyphs are wider than one", spanX(changed(bitmap(), drawBadge(bitmap(), "9+", STYLE))) > spanX(pts), true);
const short = Buffer.alloc(16);
eq("draw: mismatched buffer size is returned untouched", drawBadge(short, "9", STYLE).equals(Buffer.alloc(16)), true);

// --- redact ---
const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
eq("redact: authorization header", redact({ authorization: `Bearer ${JWT}` }).authorization, `<redacted len=${`Bearer ${JWT}`.length}>`);
eq("redact: Authorization is case/dash insensitive", redact({ "Proxy-Authorization": "x" })["Proxy-Authorization"], "<redacted len=1>");
eq("redact: cookie header", redact({ cookie: "session=abc" }).cookie, "<redacted len=11>");
eq("redact: non-string secret", redact({ token: { a: 1 } }).token, "<redacted>");
eq("redact: jwt inside a body string", redact({ body: `{"x":"${JWT}"}` }).body, '{"x":"<jwt redacted>"}');
eq("redact: opaque bearer inside a body string", redact({ body: "Bearer abcdefghij0123456789" }).body, "Bearer <redacted>");
eq("redact: opaque refresh_token field inside a body string", redact({ body: '{"refresh_token":"AMf-vBxQ_notAJwt","expires_in":"3600"}' }).body, '{"refresh_token":"<redacted>","expires_in":"3600"}');
eq("redact: auth query param", redact({ url: "wss://x.firebaseio.com/.ws?v=5&auth=SECRET" }).url, "wss://x.firebaseio.com/.ws?v=5&auth=<redacted>");
eq("redact: gsessionid query param", redact({ url: "https://firestore.googleapis.com/c?gsessionid=Ab9&VER=8" }).url, "https://firestore.googleapis.com/c?gsessionid=<redacted>&VER=8");
eq("redact: public api key survives", redact({ url: "https://securetoken.googleapis.com/v1/token?key=AIzaPUBLIC" }).url, "https://securetoken.googleapis.com/v1/token?key=AIzaPUBLIC");
eq("redact: ordinary fields survive", redact({ status: 200, ok: true, type: "message" }), { status: 200, ok: true, type: "message" });
eq("redact: hasRefreshToken is not a secret", redact({ hasRefreshToken: true }).hasRefreshToken, true);
eq("redact: last_created_at is not a secret", redact({ last_created_at: "2026-01-01" }).last_created_at, "2026-01-01");
eq("redact: walks arrays and nesting", redact({ a: [{ idToken: "zz" }] }).a[0].idToken, "<redacted len=2>");
eq("redact: leaves primitives alone", redact(null), null);

fs.unlinkSync(outfile);
if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nall daemon logic tests passed");
