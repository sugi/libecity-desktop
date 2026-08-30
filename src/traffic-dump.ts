import { app, WebContents } from "electron";
import * as fs from "fs";
import * as path from "path";
import { redact } from "./redact";

// Off by default in packaged and unpackaged runs alike. Attaching the debugger
// claims the CDP slot DevTools needs, the capture grows without bound, and it
// holds the user's chat traffic - none of which belongs in a normal run. The
// env var exists because passing argv through `electron-forge start` is fiddly.
const flag = (arg: string, env: string) =>
  process.argv.includes(arg) || process.env[env] === "1";

const DUMP_SECRETS = flag("--dump-secrets", "LIBECITY_DUMP_SECRETS");
// --dump-secrets on its own would otherwise silently capture nothing.
const DUMP_ENABLED = flag("--dump-api", "LIBECITY_DUMP") || DUMP_SECRETS;

// Only hosts that could carry the chat/session API surface. Static assets and
// third-party trackers would drown the dump.
const DUMP_HOSTS = [
  "libecity.com",
  "firestore.googleapis.com",
  "securetoken.googleapis.com",
  "identitytoolkit.googleapis.com",
  "firebaseinstallations.googleapis.com",
  "fcmregistrations.googleapis.com",
  "firebaseio.com",
];

const SKIP_PATH =
  /\.(js|mjs|css|png|jpe?g|gif|svg|webp|avif|woff2?|ttf|eot|ico|map|mp4|webm)(\?|$)/i;
const MAX_BODY = 256 * 1024;

let stream: fs.WriteStream | undefined;
let currentPath: string | undefined;

export function openDump(): string | undefined {
  if (!DUMP_ENABLED) return undefined;
  const dir = path.join(app.getPath("userData"), "dump");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  currentPath = path.join(dir, `session-${stamp}.jsonl`);
  stream = fs.createWriteStream(currentPath, { flags: "a", mode: 0o600 });
  record("meta", {
    warning: DUMP_SECRETS
      ? "Contains ID tokens, refresh tokens and Authorization headers. Do not share."
      : "Credentials are redacted, but bodies still hold chat content and account data. Review before sharing.",
    secrets: DUMP_SECRETS,
    file: currentPath,
  });
  return currentPath;
}

export function closeDump(): void {
  stream?.end();
  stream = undefined;
}

export function record(kind: string, data: unknown): void {
  if (!stream) return;
  stream.write(
    JSON.stringify({
      t: new Date().toISOString(),
      kind,
      data: DUMP_SECRETS ? data : redact(data),
    }) + "\n"
  );
}

const isInteresting = (url: string): boolean => {
  if (!/^https?:/.test(url)) return false;
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return false;
  }
  if (!DUMP_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return false;
  return !SKIP_PATH.test(url);
};

const clip = (body: string) =>
  body.length > MAX_BODY
    ? { truncated: true, length: body.length, body: body.slice(0, MAX_BODY) }
    : { truncated: false, length: body.length, body };

type PendingRequest = {
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  postData?: string;
  status?: number;
  responseHeaders?: Record<string, string>;
  mimeType?: string;
};

// Uses CDP rather than session.webRequest because only the debugger protocol
// exposes response bodies, which is where the Firestore WebChannel payloads are.
export async function attachTrafficDump(wc: WebContents): Promise<void> {
  // Bail before debugger.attach so an ordinary run leaves DevTools usable.
  if (!stream) return;
  try {
    wc.debugger.attach("1.3");
  } catch (err) {
    record("dump-error", { at: "attach", error: String(err) });
    return;
  }

  const pending = new Map<string, PendingRequest>();

  wc.debugger.on("message", (_event, method, params) => {
    void handle(method, params as Record<string, unknown>);
  });

  const handle = async (method: string, params: Record<string, unknown>) => {
    try {
      switch (method) {
        case "Network.requestWillBeSent": {
          const id = params.requestId as string;
          const req = params.request as {
            url: string;
            method: string;
            headers: Record<string, string>;
            postData?: string;
            hasPostData?: boolean;
          };
          if (!isInteresting(req.url)) return;
          let postData = req.postData;
          if (!postData && req.hasPostData) {
            postData = await getPostData(wc, id);
          }
          pending.set(id, {
            url: req.url,
            method: req.method,
            requestHeaders: req.headers,
            postData,
          });
          return;
        }
        case "Network.responseReceived": {
          const id = params.requestId as string;
          const entry = pending.get(id);
          if (!entry) return;
          const res = params.response as {
            status: number;
            headers: Record<string, string>;
            mimeType: string;
          };
          entry.status = res.status;
          entry.responseHeaders = res.headers;
          entry.mimeType = res.mimeType;
          return;
        }
        case "Network.loadingFinished": {
          const id = params.requestId as string;
          const entry = pending.get(id);
          if (!entry) return;
          pending.delete(id);
          record("http", { ...entry, response: await getBody(wc, id) });
          return;
        }
        case "Network.loadingFailed": {
          const id = params.requestId as string;
          const entry = pending.get(id);
          if (!entry) return;
          pending.delete(id);
          record("http-failed", { ...entry, error: params.errorText });
          return;
        }
        case "Network.webSocketCreated": {
          const url = params.url as string;
          if (isInteresting(url)) record("ws-open", { url });
          return;
        }
        case "Network.webSocketFrameSent":
        case "Network.webSocketFrameReceived": {
          const frame = params.response as { payloadData?: string };
          record(method === "Network.webSocketFrameSent" ? "ws-send" : "ws-recv", {
            requestId: params.requestId,
            payload: frame?.payloadData?.slice(0, MAX_BODY),
          });
          return;
        }
      }
    } catch (err) {
      record("dump-error", { at: method, error: String(err) });
    }
  };

  await wc.debugger.sendCommand("Network.enable", {
    maxTotalBufferSize: 100_000_000,
    maxResourceBufferSize: 20_000_000,
  });
  record("dump-ready", { url: wc.getURL() });
}

const getPostData = async (wc: WebContents, requestId: string) => {
  try {
    const r = (await wc.debugger.sendCommand("Network.getRequestPostData", {
      requestId,
    })) as { postData?: string };
    return r.postData;
  } catch {
    return undefined;
  }
};

const getBody = async (wc: WebContents, requestId: string) => {
  try {
    const r = (await wc.debugger.sendCommand("Network.getResponseBody", {
      requestId,
    })) as { body: string; base64Encoded: boolean };
    if (r.base64Encoded) return { base64: true, length: r.body.length };
    return clip(r.body);
  } catch (err) {
    return { unavailable: String(err) };
  }
};
