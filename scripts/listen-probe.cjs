// Probe for the Firestore listener that replaced the 30s getCategories poll.
// Answers five questions in one run:
//
//   1. can the main process restore the logged-in user from a refresh token?
//   2. do the security rules let us read users/{uid}/notices?
//   3. what do those notice documents actually contain?
//   4. does the users/{uid} doc listener receive snapshots at all?
//   5. does the notices listener - run with the exact query and options the
//      app ships (where("created_at", ">", now - 5min), no orderBy, no
//      limit, includeMetadataChanges: true) - actually DELIVER a live
//      notice, not just subscribe to the collection?
//
// "notices subscribe" and "notices live delivery" are reported as separate
// results. A first snapshot is indistinguishable from a live update - every
// document in it arrives as an "added" change - so subscribing proves
// nothing about delivery by itself. Live delivery is only PASS when an
// "added" change arrives for a document id outside that first snapshot's
// baseline; a short run on a quiet account legitimately SKIPs it instead,
// and a SKIP here does not fail the run. To exercise that path for real,
// trigger a notice (DM yourself, react to something) during the run and
// give it time to arrive - try --seconds 1800.
//
// A sixth question, opt-in via --offline-test: is the cache/server
// transition that demotes the app to polling actually observable, or is
// includeMetadataChanges doing nothing? This drives disableNetwork()/
// enableNetwork() (SDK-level, no real network touched) and checks that both
// subscriptions each deliver a fromCache flip with no document changes. See
// the comment above runOfflineTest() for what this does and does not prove.
//
// Run via: npx electron scripts/listen-probe.cjs [--seconds 90] [--verbose] [--offline-test]
// Under plain node instead, pass the token: LIBECITY_REFRESH_TOKEN=... node scripts/listen-probe.cjs
//
// Message bodies and display names are replaced with <string:len> unless
// --verbose is given, so the output can be pasted somewhere without leaking
// the contents of your DMs.

const fs = require("fs");
const path = require("path");
const os = require("os");

const { initializeApp } = require("firebase/app");
const { initializeAuth } = require("firebase/auth");
const {
  getFirestore,
  collection,
  doc,
  onSnapshot,
  query,
  where,
  Timestamp,
  disableNetwork,
  enableNetwork,
} = require("firebase/firestore");

// Published by the site itself at https://libecity.com/swenv.js
const API_KEY = "AIzaSyDxUFU2BiEQ1By3EKL8DL6IxoWgzutmR18";
const PROJECT_ID = "production-b8884";
const SECURETOKEN = `https://securetoken.googleapis.com/v1/token?key=${API_KEY}`;
const FIRESTORE_REST = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const VERBOSE = argv.includes("--verbose");
const OFFLINE_TEST = argv.includes("--offline-test");
const SECONDS_RAW = flag("seconds", "90");
const SECONDS = Number(SECONDS_RAW);
if (!Number.isFinite(SECONDS) || SECONDS <= 0) {
  // Runs before the Electron app is ready (or under plain node), so this
  // can only be process.exit - app.exit isn't safe to call yet.
  console.error(`--seconds must be a positive number, got ${JSON.stringify(SECONDS_RAW)}`);
  process.exit(1);
}

// Mirrors OVERLAP_MS and LISTEN_OPTIONS in src/notice-listener.ts - the probe
// has to run the same query with the same options as what ships, not
// something "close enough", or rules and indexing for the shipping shape are
// still unexercised.
const NOTICES_OVERLAP_MS = 5 * 60_000;
const LISTEN_OPTIONS = { includeMetadataChanges: true };

// Set from Electron before the app rewrites its own userData path.
let userDataBase;

// Personal content we do not want in pasted output. Ids and enums are kept -
// they are what the URL derivation needs.
const REDACT = new Set([
  "message",
  "user_name",
  "original_title",
  "room_name",
  "other_link_title",
  "other_live_name",
  "meet_up_place",
  "icon_url",
  "thumbnail_url",
  "sender_icon",
  "room_icon",
]);

const show = (key, value) => {
  if (VERBOSE) return JSON.stringify(value);
  if (REDACT.has(key) && typeof value === "string") return `<string:${value.length}>`;
  if (value && typeof value === "object") {
    if (typeof value.toDate === "function") return value.toDate().toISOString();
    return `<${Array.isArray(value) ? "array" : "object"}:${Object.keys(value).length}>`;
  }
  return JSON.stringify(value);
};

const summary = [];
// Set by fail() and read by finish(): a run that resolves normally must still
// exit non-zero if anything along the way was recorded as failed. Without
// this, run() resolving always exits 0 regardless of what got logged above.
let hadFailure = false;
const pass = (label, detail) => summary.push(`${label.padEnd(20)}: PASS ${detail ?? ""}`);
const fail = (label, detail) => {
  hadFailure = true;
  summary.push(`${label.padEnd(20)}: FAIL ${detail ?? ""}`);
};
const skip = (label, detail) => summary.push(`${label.padEnd(20)}: SKIP ${detail ?? ""}`);

// ---- credentials ---------------------------------------------------------

function readRefreshToken() {
  const fromEnv = process.env.LIBECITY_REFRESH_TOKEN;
  if (fromEnv) return { token: fromEnv, source: "LIBECITY_REFRESH_TOKEN" };

  if (!process.versions.electron) {
    throw new Error(
      "no refresh token: run under electron, or set LIBECITY_REFRESH_TOKEN"
    );
  }
  const { safeStorage } = require("electron");
  const explicit = flag("session", undefined);
  const candidates = explicit
    ? [explicit]
    : [
        // main.ts appends -dev to userData when not packaged
        path.join(userDataBase, "libecity-desktop-dev", "session.bin"),
        path.join(userDataBase, "libecity-desktop", "session.bin"),
      ];

  for (const file of candidates) {
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch {
      continue;
    }
    const asText = buf.toString("utf8");
    if (asText.startsWith("plain:")) {
      return { token: asText.slice("plain:".length), source: file };
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(`${file} is encrypted but no OS keychain is available`);
    }
    return { token: safeStorage.decryptString(buf), source: file };
  }
  throw new Error(`no session.bin found (looked in ${candidates.join(", ")})`);
}

async function mintIdToken(refreshToken) {
  const res = await fetch(SECURETOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.id_token) {
    throw new Error(`token refresh failed: status=${res.status}`);
  }
  return {
    idToken: body.id_token,
    refreshToken: body.refresh_token ?? refreshToken,
    uid: body.user_id,
    expiresIn: Number(body.expires_in ?? "3600"),
  };
}

// ---- 2. can we read the notices subcollection at all? --------------------

const restValue = (v) => {
  if (v == null) return null;
  const [kind, raw] = Object.entries(v)[0] ?? [];
  switch (kind) {
    case "integerValue":
      return Number(raw);
    case "booleanValue":
    case "stringValue":
    case "timestampValue":
    case "doubleValue":
      return raw;
    case "nullValue":
      return null;
    default:
      return { [kind]: "…" };
  }
};

async function probeNoticesRest(uid, idToken) {
  const url = `${FIRESTORE_REST}/users/${uid}/notices?pageSize=3`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
  const body = await res.json().catch(() => ({}));
  console.log(`\n== REST read of users/{uid}/notices -> ${res.status} ==`);
  if (!res.ok) {
    fail("notices REST read", `status=${res.status} ${JSON.stringify(body).slice(0, 200)}`);
    return;
  }
  const docs = body.documents ?? [];
  pass("notices REST read", `${docs.length} document(s)`);
  for (const d of docs) {
    console.log(`\n  ${d.name.split("/").slice(-1)[0]}  (createTime ${d.createTime})`);
    for (const [k, v] of Object.entries(d.fields ?? {})) {
      console.log(`    ${k.padEnd(24)} ${show(k, restValue(v))}`);
    }
  }
  if (!docs.length) {
    console.log("  (collection is empty or nothing is readable)");
  }
}

// ---- 1. restore the SDK's auth state from the refresh token --------------

// The SDK has no public "sign in with a refresh token", so hand it the blob it
// would have written itself and let it take over from there. This reaches into
// the shape of the persistence layer, which is why it gets probed rather than
// assumed. initializeAuth instantiates what it is given, so this has to be a
// class rather than an object - passing an instance fails the SDK's own
// "Expected a class definition" assertion.
function seededPersistence(blob) {
  const store = new Map([[`firebase:authUser:${API_KEY}:[DEFAULT]`, blob]]);
  class SeededPersistence {
    constructor() {
      this.type = "LOCAL";
    }
    async _isAvailable() {
      return true;
    }
    async _set(k, v) {
      store.set(k, v);
    }
    async _get(k) {
      return store.get(k) ?? null;
    }
    async _remove(k) {
      store.delete(k);
    }
    _addListener() {}
    _removeListener() {}
  }
  SeededPersistence.type = "LOCAL";
  return SeededPersistence;
}

async function restoreAuth(app, token) {
  const now = Date.now();
  const blob = {
    uid: token.uid,
    email: null,
    emailVerified: true,
    displayName: null,
    isAnonymous: false,
    photoURL: null,
    providerData: [],
    stsTokenManager: {
      refreshToken: token.refreshToken,
      accessToken: token.idToken,
      expirationTime: now + token.expiresIn * 1000,
    },
    createdAt: String(now),
    lastLoginAt: String(now),
    apiKey: API_KEY,
    appName: "[DEFAULT]",
  };
  const auth = initializeAuth(app, { persistence: seededPersistence(blob) });
  await auth.authStateReady();
  return auth;
}

// ---- 3 & 4. listen -------------------------------------------------------

function listen(db, uid, counters) {
  const stops = [];

  stops.push(
    onSnapshot(
      doc(db, "users", uid),
      LISTEN_OPTIONS,
      (snap) => {
        counters.userDoc++;
        const d = snap.data() ?? {};
        console.log(
          `\n[user doc #${counters.userDoc}] fromCache=${snap.metadata.fromCache} ` +
            `unread_notice=${d.unread_notice} ` +
            `notice_unread_counts=${JSON.stringify(d.notice_unread_counts ?? null)}`
        );
      },
      (err) => {
        counters.userDocErrored = true;
        fail("user doc listen", `${err.code}: ${err.message}`);
      }
    )
  );

  // Same shape src/notice-listener.ts subscribes with: an inequality on
  // created_at with a 5-minute overlap, no orderBy, no limit. That is what
  // actually needs an index and a rules pass - the old orderBy+limit query
  // proved nothing about either.
  const since = Timestamp.fromDate(new Date(Date.now() - NOTICES_OVERLAP_MS));
  const q = query(collection(db, "users", uid, "notices"), where("created_at", ">", since));
  stops.push(
    onSnapshot(
      q,
      LISTEN_OPTIONS,
      (snap) => {
        counters.noticeSnapshots++;
        const fromCache = snap.metadata.fromCache;
        console.log(
          `\n[notices #${counters.noticeSnapshots}] ${snap.size} doc(s), ` +
            `${snap.docChanges().length} change(s), fromCache=${fromCache}`
        );
        for (const change of snap.docChanges()) {
          counters.noticeChanges++;
          const d = change.doc.data();
          console.log(`  ${change.type} ${change.doc.id}`);
          for (const [k, v] of Object.entries(d)) {
            console.log(`    ${k.padEnd(24)} ${show(k, v)}`);
          }
        }
        // A cache replay proves nothing about the server, same as the
        // shipping listener - it returns before touching its own baseline.
        if (fromCache) return;
        // The first server snapshot is the baseline: every one of its
        // documents arrives as an "added" change, and none of that is
        // evidence of live delivery. Recording it here, once, is what lets
        // "subscribed" and "delivered" be told apart below.
        if (!counters.noticeSubscribed) {
          counters.noticeSubscribed = true;
          counters.noticeBaselineIds = new Set(snap.docs.map((d) => d.id));
        }
        if (!counters.noticeDelivered) {
          for (const change of snap.docChanges()) {
            if (change.type !== "added") continue;
            if (counters.noticeBaselineIds.has(change.doc.id)) continue;
            counters.noticeDelivered = true;
            counters.noticeDeliveredId = change.doc.id;
            break;
          }
        }
      },
      (err) => {
        counters.noticeErrored = true;
        fail("notices subscribe", `${err.code}: ${err.message}`);
      }
    )
  );

  return () => stops.forEach((stop) => stop());
}

// ---- --offline-test: prove the fromCache transition is observable --------
//
// The shipping listener (src/notice-listener.ts) only demotes to polling
// because both onSnapshot calls pass { includeMetadataChanges: true }:
// without it, shouldRaiseEvent returns false for a snapshot whose docChanges
// are empty, so a cache/server transition with no document changes would
// raise no event at all and the demotion path would be dead code. This mode
// proves the event mechanism actually fires.
//
// disableNetwork(db)/enableNetwork(db) put the SDK client offline and back
// online without touching the real network - no wifi toggling, no dropped
// SSH session. That drives the same code path a real outage does (a
// snapshot with fromCache flipped and zero document changes), so it
// exercises the part in question. It does NOT reproduce a real outage's
// timing - Online -> Unknown -> Offline, retries, a ten-second timeout - so
// a PASS here does not stand in for running with the network actually cut.
async function runOfflineTest(db, uid) {
  console.log("\n== --offline-test: verifying the cache/server transition fires ==");

  // The first server snapshot on a cold connection makes a real round trip,
  // so it gets the same bound as an ordinary run's whole listen window.
  // disableNetwork/enableNetwork are local SDK state flips with no network
  // round trip involved, so 10s is generous headroom, not a measured budget.
  const BASELINE_TIMEOUT_MS = SECONDS * 1000;
  const TRANSITION_TIMEOUT_MS = 10_000;

  // One-shot waiter per stream: lets each step below await "the next
  // snapshot matching this predicate" without touching listen()'s counters,
  // whose baseline/live-delivery bookkeeping this mode has no business
  // disturbing. Only ever one predicate in flight per stream at a time.
  function watcher() {
    let waiting = null;
    return {
      feed(snap) {
        // A DocumentSnapshot has no docChanges(); only a QuerySnapshot does.
        // This watcher feeds both streams, so ask before calling.
        const changes =
          typeof snap.docChanges === "function" ? snap.docChanges().length : 0;
        const info = { fromCache: snap.metadata.fromCache, changes };
        if (waiting && waiting.predicate(info)) {
          const resolve = waiting.resolve;
          waiting = null;
          resolve(info);
        }
      },
      next(predicate, timeoutMs) {
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            waiting = null;
            resolve(null);
          }, timeoutMs);
          waiting = {
            predicate,
            resolve: (info) => {
              clearTimeout(timer);
              resolve(info);
            },
          };
        });
      },
    };
  }

  const userWatcher = watcher();
  const noticeWatcher = watcher();

  const stops = [];
  stops.push(
    onSnapshot(
      doc(db, "users", uid),
      LISTEN_OPTIONS,
      (snap) => userWatcher.feed(snap),
      (err) => fail("offline-test user doc", `${err.code}: ${err.message}`)
    )
  );
  const since = Timestamp.fromDate(new Date(Date.now() - NOTICES_OVERLAP_MS));
  const q = query(collection(db, "users", uid, "notices"), where("created_at", ">", since));
  stops.push(
    onSnapshot(
      q,
      LISTEN_OPTIONS,
      (snap) => noticeWatcher.feed(snap),
      (err) => fail("offline-test notices", `${err.code}: ${err.message}`)
    )
  );

  const missingEventDetail = (caller, timeoutMs) =>
    `no snapshot within ${timeoutMs}ms of ${caller} - the includeMetadataChanges reasoning ` +
    `may be wrong: a real outage would leave this listener reporting healthy while blind`;

  try {
    // ---- step 1: wait for the initial server snapshot on both streams ----
    const t0 = Date.now();
    const baselineUserP = userWatcher.next((i) => !i.fromCache, BASELINE_TIMEOUT_MS);
    const baselineNoticeP = noticeWatcher.next((i) => !i.fromCache, BASELINE_TIMEOUT_MS);
    const [baselineUser, baselineNotice] = await Promise.all([baselineUserP, baselineNoticeP]);
    if (!baselineUser || !baselineNotice) {
      fail(
        "offline-test baseline",
        `timed out after ${BASELINE_TIMEOUT_MS}ms waiting for an initial server snapshot ` +
          `(user=${baselineUser ? "ok" : "MISSING"}, notices=${baselineNotice ? "ok" : "MISSING"}) - ` +
          `cannot run the disable/enable network steps without one`
      );
      return;
    }
    pass("offline-test baseline", `both streams reached fromCache=false in ${Date.now() - t0}ms`);

    // ---- step 2: disableNetwork() -> expect fromCache=true, no changes ---
    const offUserP = userWatcher.next((i) => i.fromCache, TRANSITION_TIMEOUT_MS);
    const offNoticeP = noticeWatcher.next((i) => i.fromCache, TRANSITION_TIMEOUT_MS);
    console.log("\ncalling disableNetwork(db) ...");
    const offStart = Date.now();
    try {
      await disableNetwork(db);
    } catch (err) {
      fail("offline-test disableNetwork()", String(err));
      return;
    }

    const offUser = await offUserP;
    if (offUser) {
      const note = offUser.changes > 0 ? " (unexpected: expected 0 doc changes)" : "";
      pass("offline-test user->offline", `fromCache=true after ${Date.now() - offStart}ms, ${offUser.changes} doc change(s)${note}`);
    } else {
      fail("offline-test user->offline", missingEventDetail("disableNetwork()", TRANSITION_TIMEOUT_MS));
    }

    const offNotice = await offNoticeP;
    if (offNotice) {
      const note = offNotice.changes > 0 ? " (unexpected: expected 0 doc changes)" : "";
      pass("offline-test notices->offline", `fromCache=true after ${Date.now() - offStart}ms, ${offNotice.changes} doc change(s)${note}`);
    } else {
      fail("offline-test notices->offline", missingEventDetail("disableNetwork()", TRANSITION_TIMEOUT_MS));
    }

    // ---- step 3: enableNetwork() -> expect fromCache=false again ---------
    const onUserP = userWatcher.next((i) => !i.fromCache, TRANSITION_TIMEOUT_MS);
    const onNoticeP = noticeWatcher.next((i) => !i.fromCache, TRANSITION_TIMEOUT_MS);
    console.log("calling enableNetwork(db) ...");
    const onStart = Date.now();
    try {
      await enableNetwork(db);
    } catch (err) {
      fail("offline-test enableNetwork()", String(err));
      return;
    }

    const onUser = await onUserP;
    if (onUser) {
      pass("offline-test user->online", `fromCache=false after ${Date.now() - onStart}ms`);
    } else {
      fail("offline-test user->online", missingEventDetail("enableNetwork()", TRANSITION_TIMEOUT_MS));
    }

    const onNotice = await onNoticeP;
    if (onNotice) {
      pass("offline-test notices->online", `fromCache=false after ${Date.now() - onStart}ms`);
    } else {
      fail("offline-test notices->online", missingEventDetail("enableNetwork()", TRANSITION_TIMEOUT_MS));
    }
  } finally {
    stops.forEach((stop) => stop());
  }
}

// ---- main ----------------------------------------------------------------

async function run() {
  const { token: refreshToken, source } = readRefreshToken();
  console.log(`refresh token from ${source}`);

  const token = await mintIdToken(refreshToken);
  pass("token refresh", `uid=${token.uid}`);

  await probeNoticesRest(token.uid, token.idToken);

  const app = initializeApp({
    apiKey: API_KEY,
    authDomain: `${PROJECT_ID}.firebaseapp.com`,
    projectId: PROJECT_ID,
  });

  let auth;
  try {
    auth = await restoreAuth(app, token);
  } catch (err) {
    fail("sdk auth restore", String(err));
    return;
  }
  if (auth.currentUser?.uid === token.uid) {
    pass("sdk auth restore", `currentUser=${auth.currentUser.uid}`);
  } else {
    fail("sdk auth restore", `currentUser=${auth.currentUser?.uid ?? "null"}`);
    return;
  }

  const db = getFirestore(app);

  if (OFFLINE_TEST) {
    await runOfflineTest(db, token.uid);
    return;
  }

  const counters = {
    userDoc: 0,
    noticeSnapshots: 0,
    noticeChanges: 0,
    noticeSubscribed: false,
    noticeBaselineIds: new Set(),
    noticeDelivered: false,
    noticeDeliveredId: undefined,
    noticeErrored: false,
    userDocErrored: false,
  };
  const stop = listen(db, token.uid, counters);

  console.log(
    `\nlistening for ${SECONDS}s - send yourself a DM or a reaction to see a live change`
  );
  await new Promise((resolve) => setTimeout(resolve, SECONDS * 1000));
  stop();

  if (counters.userDocErrored) {
    // The onSnapshot error callback already recorded the FAIL for this -
    // do not also add a PASS just because snapshots arrived before it errored.
  } else if (counters.userDoc > 0) {
    pass("user doc listen", `${counters.userDoc} snapshot(s)`);
  } else {
    fail("user doc listen", "no snapshot");
  }

  // "subscribe" and "live delivery" are deliberately separate results: the
  // first server snapshot alone proves subscription, never delivery, so a
  // PASS on delivery requires an "added" change the baseline did not already
  // account for. Falling short of that within the run is a SKIP, not a PASS -
  // and not a FAIL either, since a quiet account is not a broken listener.
  if (counters.noticeErrored) {
    // The onSnapshot error callback already recorded the FAIL for this.
    skip("notices live delivery", "notices subscribe failed - see above");
  } else if (counters.noticeSubscribed) {
    pass("notices subscribe", `${counters.noticeBaselineIds.size} baseline doc(s)`);
    if (counters.noticeDelivered) {
      pass("notices live delivery", `id=${counters.noticeDeliveredId}`);
    } else {
      skip(
        "notices live delivery",
        `no added change outside the baseline in ${SECONDS}s - trigger a notice ` +
          `and rerun with --seconds 1800 to observe this`
      );
    }
  } else {
    fail("notices subscribe", "no server (fromCache=false) snapshot");
    skip("notices live delivery", "subscribe did not complete");
  }
}

const finish = (code) => {
  // A resolved run() with any fail() recorded must not exit 0: hadFailure
  // overrides whatever code the caller thought was appropriate.
  const exitCode = hadFailure ? 1 : code;
  console.log(`\n== SUMMARY (${os.platform()}, firebase ${require("firebase/package.json").version}) ==`);
  for (const line of summary) console.log(line);
  if (process.versions.electron) require("electron").app.exit(exitCode);
  else process.exit(exitCode);
};

const main = () =>
  run().then(
    () => finish(0),
    (err) => {
      console.error("\nprobe failed:", err);
      fail("probe", String(err));
      finish(1);
    }
  );

if (process.versions.electron) {
  const { app } = require("electron");
  // Read session.bin from where the app keeps it, but keep the probe's own
  // Chromium state out of that directory so it cannot disturb a running app.
  userDataBase = path.dirname(app.getPath("userData"));
  app.setPath("userData", path.join(os.tmpdir(), "libecity-listen-probe"));
  app.on("window-all-closed", () => {});
  app.whenReady().then(main);
} else {
  main();
}
