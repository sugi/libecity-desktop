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
      export { computeState, diffNotifications } from "./src/notification-daemon.ts";
      export { parseCategories } from "./src/libecity-api.ts";
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
const { computeState, diffNotifications, parseCategories } = mod;

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

fs.unlinkSync(outfile);
if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nall daemon logic tests passed");
