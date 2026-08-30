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
      export { diffNotifications } from "./src/notification-daemon.ts";
      export { computeState, unreadTotal, stateFromCounts, totalFromCounts } from "./src/tray-state.ts";
      export { parseCategories } from "./src/libecity-api.ts";
      export { badgeText, drawBadge } from "./src/tray-badge.ts";
      export { redact } from "./src/redact.ts";
      export { noticeUrl, noticeCategory, capNotices } from "./src/notice.ts";
      export { noticeTitle, noticeBody, notificationTitle } from "./src/notice-text.ts";
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
const {
  computeState,
  diffNotifications,
  unreadTotal,
  stateFromCounts,
  totalFromCounts,
  parseCategories,
  badgeText,
  drawBadge,
  redact,
  noticeUrl,
  noticeCategory,
  capNotices,
  noticeTitle,
  noticeBody,
  notificationTitle,
} = mod;

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
eq("total: negative counts do not reduce the total", unreadTotal([cat("message", 2, "t1"), cat("dm", -5, "t1")]), 2);

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

// --- noticeUrl ---
const N = (type, fields = {}) => ({ documentId: `${type}-1`, type, ...fields });
const SITE = "https://libecity.com";
eq("url: mention -> room + comment",
  noticeUrl(N("mention", { room_id: "R1", message_id: "M1" })),
  `${SITE}/room_list?room_id=R1&comment_id=M1`);
eq("url: to_all -> room + comment",
  noticeUrl(N("to_all", { room_id: "R1", message_id: "M1" })),
  `${SITE}/room_list?room_id=R1&comment_id=M1`);
eq("url: dm -> room only",
  noticeUrl(N("dm", { room_id: "R2" })), `${SITE}/room_list?room_id=R2`);
eq("url: followed -> profile",
  noticeUrl(N("followed", { follower_uid: "U9" })), `${SITE}/user_profile/U9`);
eq("url: event with both ids",
  noticeUrl(N("event_calendar", { event_id: "E1", event_host_id: "H1" })),
  `${SITE}/mypage/event_calendar?event=H1-E1`);
eq("url: event missing an id falls back to the page",
  noticeUrl(N("event_calendar", { event_id: "E1" })), `${SITE}/mypage/event_calendar`);
eq("url: reaction_tweet prefers tweet_id",
  noticeUrl(N("reaction_tweet", { tweet_id: "T1", reply_tweet_id: "R1" })),
  `${SITE}/tweet/my?reaction_tweet_id=T1`);
eq("url: reaction_tweet falls back to the reply",
  noticeUrl(N("reaction_tweet", { reply_tweet_id: "R1" })),
  `${SITE}/tweet/my?reaction_reply_tweet_id=R1`);
eq("url: reply_tweet strips the tweets/ prefix",
  noticeUrl(N("reply_tweet", { parent_tweet_path: "tweets/P1" })),
  `${SITE}/tweet/my?reply_tweet_id=P1`);
eq("url: point_reaction with a key",
  noticeUrl(N("point_reaction", { point_key: "K1" })),
  `${SITE}/mypage/point_histories?point_key=K1`);
eq("url: point_reaction without a key still lands on the page",
  noticeUrl(N("point_reaction")), `${SITE}/mypage/point_histories`);
eq("url: point_receive -> points",
  noticeUrl(N("point_receive")), `${SITE}/mypage/points`);
eq("url: live type passes other_url through untouched",
  noticeUrl(N("beginners_live", { other_url: "https://www.youtube.com/live/x" })),
  "https://www.youtube.com/live/x");
eq("url: unknown type with no other_url -> undefined",
  noticeUrl(N("something_new")), undefined);
eq("url: a document with no fields at all does not throw",
  noticeUrl({ documentId: "d", type: "mention" }),
  `${SITE}/room_list?room_id=&comment_id=`);

// --- noticeCategory ---
eq("category: mention -> message", noticeCategory("mention"), "message");
eq("category: official_dm_mention -> official_dm", noticeCategory("official_dm_mention"), "official_dm");
eq("category: beginners_live -> live", noticeCategory("beginners_live"), "live");
eq("category: unknown -> undefined", noticeCategory("nope"), undefined);

// --- capNotices ---
const at = (iso) => ({ toDate: () => new Date(iso) });
const stamped = (n, iso) => ({ documentId: `d${n}`, type: "mention", created_at: at(iso) });
const five = [1, 2, 3, 4, 5].map((i) => stamped(i, `2026-01-0${i}T00:00:00Z`));
eq("cap: under the cap fires everything", capNotices(five, 5).fire.length, 5);
eq("cap: under the cap collapses nothing", capNotices(five, 5).collapsed, 0);
const seven = [1, 2, 3, 4, 5, 6, 7].map((i) => stamped(i, `2026-01-0${i}T00:00:00Z`));
eq("cap: over the cap fires the cap", capNotices(seven, 5).fire.length, 5);
eq("cap: over the cap collapses the rest", capNotices(seven, 5).collapsed, 2);
eq("cap: keeps the newest", capNotices(seven, 5).fire.map((n) => n.documentId), ["d3", "d4", "d5", "d6", "d7"]);
eq("cap: fires oldest first", capNotices(seven, 5).fire[0].documentId, "d3");
eq("cap: sorts unordered input", capNotices([stamped(2, "2026-01-02T00:00:00Z"), stamped(1, "2026-01-01T00:00:00Z")], 5).fire.map((n) => n.documentId), ["d1", "d2"]);
eq("cap: undated notices do not throw", capNotices([{ documentId: "x", type: "mention" }], 5).fire.length, 1);

// --- noticeTitle ---
eq("title: original_title wins",
  noticeTitle({ documentId: "d", type: "mention", original_title: "既定の文言", user_name: "太郎" }),
  "既定の文言");
eq("title: mention names the sender",
  noticeTitle({ documentId: "d", type: "mention", user_name: "太郎" }),
  "太郎さんからメッセージが届いています！");
eq("title: to_all is the broadcast wording",
  noticeTitle({ documentId: "d", type: "to_all", user_name: "太郎" }),
  "太郎さんから全体宛てメッセージが届いています！");
eq("title: reaction counts",
  noticeTitle({ documentId: "d", type: "reaction", count: 8 }),
  "本日、メッセージにリアクションがありました（合計8件）");
eq("title: usercommunity has no room to name",
  noticeTitle({ documentId: "d", type: "usercommunity_approved" }),
  "-への参加申請が承認されました。");
eq("title: delete_completed uses room_name",
  noticeTitle({ documentId: "d", type: "usercommunity_delete_completed", room_name: "勉強部屋" }),
  "【削除完了】勉強部屋の自動削除が完了しました");
eq("title: live prefixes the date",
  noticeTitle({ documentId: "d", type: "beginners_live", created_at: { toDate: () => new Date("2026-03-05T00:00:00Z") } }),
  "【03/05】リベシティ使い方ライブが始まりました！");
eq("title: point_receive formats the amount",
  noticeTitle({ documentId: "d", type: "point_receive", user_name: "太郎", point_amount: 1500 }),
  "太郎さんから1,500pt届きました🎁");
eq("title: point_receive from リベシティ drops the honorific",
  noticeTitle({ documentId: "d", type: "point_receive", user_name: "リベシティ", point_amount: 10 }),
  "リベシティから10pt届きました🎁");
eq("title: an unknown type falls back instead of throwing",
  noticeTitle({ documentId: "d", type: "brand_new_type" }),
  "新しいお知らせがあります");
eq("title: an unknown type prefers its message",
  noticeTitle({ documentId: "d", type: "brand_new_type", message: "本文" }),
  "本文");

// --- noticeBody ---
eq("body: message types show a preview",
  noticeBody({ documentId: "d", type: "mention", user_name: "太郎", message: "<p>こんにちは</p>" }),
  "太郎さん：こんにちは");
eq("body: html entities are decoded",
  noticeBody({ documentId: "d", type: "dm_mention", user_name: "太郎", message: "<p>a &amp; b</p>" }),
  "太郎さん：a & b");
eq("body: an empty message falls back to the sentence",
  noticeBody({ documentId: "d", type: "mention", user_name: "太郎", message: "" }),
  "太郎さんからメッセージが届いています！");
eq("body: an empty to_all message uses the broadcast sentence",
  noticeBody({ documentId: "d", type: "to_all", user_name: "太郎", message: "<div></div>" }),
  "太郎さんから全体宛てメッセージが届いています！");
eq("body: long previews are truncated by byte width",
  noticeBody({ documentId: "d", type: "mention", user_name: "太郎", message: "あ".repeat(40) }).endsWith("..."),
  true);
eq("body: ruled lines are compressed",
  noticeBody({ documentId: "d", type: "point_receive", original_title: "━━━━告知━━━━" }),
  "━告知━");
eq("body: non-message types reuse the title",
  noticeBody({ documentId: "d", type: "followed", user_name: "太郎" }),
  "太郎さんからフォローされました！");

// --- notificationTitle ---
eq("notification title: known category",
  notificationTitle({ documentId: "d", type: "mention" }), "リベシティ - メッセージ");
eq("notification title: live category",
  notificationTitle({ documentId: "d", type: "beginners_live" }), "リベシティ - ライブ");
eq("notification title: unknown type is unadorned",
  notificationTitle({ documentId: "d", type: "brand_new_type" }), "リベシティ");

// --- counts map ---
eq("counts: empty -> default", stateFromCounts({}), "default");
eq("counts: message only -> message", stateFromCounts({ message: 2, dm: 0 }), "message");
eq("counts: anything else -> notice", stateFromCounts({ message: 0, dm: 1 }), "notice");
eq("counts: notice outranks message", stateFromCounts({ message: 5, live: 1 }), "notice");
eq("counts: total sums every category", totalFromCounts({ message: 2, dm: 3, live: 0 }), 5);
eq("counts: total of empty -> 0", totalFromCounts({}), 0);
eq("counts: negatives are ignored", totalFromCounts({ message: -1, dm: 2 }), 2);

fs.unlinkSync(outfile);
if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nall daemon logic tests passed");
