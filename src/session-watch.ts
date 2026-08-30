import { type ExtractedSession, type SessionProbe } from "./session-extract";

export type WatchAction =
  | { kind: "none" }
  | { kind: "session"; session: ExtractedSession }
  | { kind: "signed-out" };

// Turns a stream of store probes into the two events main cares about. A
// sign-out has to survive a couple of polls: the store is briefly empty during
// a token rotation and while a fresh page is still writing it, and acting on
// the first empty read would tear down a live session.
export class SessionWatch {
  private lastRefreshToken = "";
  private sawSession = false;
  private misses = 0;

  constructor(private missesBeforeSignOut = 2) {}

  observe(probe: SessionProbe): WatchAction {
    if (probe.state === "unknown") return { kind: "none" };

    if (probe.state === "session") {
      this.sawSession = true;
      this.misses = 0;
      if (probe.session.refreshToken === this.lastRefreshToken) return { kind: "none" };
      this.lastRefreshToken = probe.session.refreshToken;
      return { kind: "session", session: probe.session };
    }

    if (!this.sawSession) return { kind: "none" };
    if (++this.misses < this.missesBeforeSignOut) return { kind: "none" };
    this.sawSession = false;
    this.misses = 0;
    this.lastRefreshToken = "";
    return { kind: "signed-out" };
  }
}
