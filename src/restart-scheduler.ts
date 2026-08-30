// Retries something that has no retry of its own, backing off so a server that
// is down is not hammered and coming back promptly when it is not. The timer
// functions are injectable so the backoff can be exercised without waiting.
export type RestartOptions = {
  // Resolves true when there is nothing left to retry - the attempt worked, or
  // the reason for retrying is gone.
  attempt: () => Promise<boolean>;
  minMs?: number;
  maxMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onSchedule?: (delayMs: number) => void;
};

export class RestartScheduler {
  private handle?: unknown;
  private delayMs = 0;
  private readonly minMs: number;
  private readonly maxMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private opts: RestartOptions) {
    this.minMs = opts.minMs ?? 30_000;
    this.maxMs = opts.maxMs ?? 15 * 60_000;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  // Callers signal a need to retry rather than a schedule, so repeated signals
  // for one outage must not stack timers or shorten the wait.
  schedule(): void {
    if (this.handle !== undefined) return;
    this.delayMs = this.delayMs ? Math.min(this.delayMs * 2, this.maxMs) : this.minMs;
    const delayMs = this.delayMs;
    this.opts.onSchedule?.(delayMs);
    this.handle = this.setTimer(() => {
      this.handle = undefined;
      void this.opts.attempt().then(
        (ok) => {
          if (ok) this.delayMs = 0;
          else this.schedule();
        },
        () => this.schedule()
      );
    }, delayMs);
  }

  cancel(): void {
    if (this.handle !== undefined) this.clearTimer(this.handle);
    this.handle = undefined;
    this.delayMs = 0;
  }
}
