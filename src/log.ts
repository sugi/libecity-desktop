import { record } from "./traffic-dump";
import { redact } from "./redact";

// Operational diagnostics, as opposed to the reverse-engineering capture in
// traffic-dump: these fire on every run and go to the console, plus into the
// dump when one is open so they interleave with the captured traffic. Always
// redacted regardless of --dump-secrets, because the console ends up in
// journald, which is wider exposure than the 0600 dump file.
export function log(kind: string, data?: unknown): void {
  record(kind, data);
  const text = data === undefined ? "" : ` ${JSON.stringify(redact(data))}`;
  console.log(`[${kind}]${text}`);
}
