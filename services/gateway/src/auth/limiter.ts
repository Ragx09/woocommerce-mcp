// Login throttling (AUTH-02): failed attempts are counted per client IP and per IP+email in a sliding
// window; over the limit → 429 with Retry-After. In memory per replica: with N replicas an attacker gets
// at most N× the budget, still far too little for guessing; a success clears the IP+email counter.
export interface LimiterOptions {
  windowMs?: number;
  /** Failures allowed per IP+email in the window. */
  perAccount?: number;
  /** Failures allowed per IP (all emails) in the window. */
  perIp?: number;
  now?: () => number;
}

export class LoginLimiter {
  private readonly fails = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly perAccount: number;
  private readonly perIp: number;
  private readonly now: () => number;

  constructor(opts: LimiterOptions = {}) {
    this.windowMs = opts.windowMs ?? 15 * 60_000;
    this.perAccount = opts.perAccount ?? 5;
    this.perIp = opts.perIp ?? 20;
    this.now = opts.now ?? Date.now;
  }

  /** Seconds to wait, or 0 when an attempt is allowed. */
  retryAfter(ip: string, email: string): number {
    const t = this.now();
    const wait = (key: string, max: number) => {
      const list = this.recent(key, t);
      return list.length >= max ? Math.ceil((list[0]! + this.windowMs - t) / 1000) : 0;
    };
    return Math.max(wait(`ip:${ip}`, this.perIp), wait(`acct:${ip}:${email}`, this.perAccount));
  }

  fail(ip: string, email: string): void {
    const t = this.now();
    for (const key of [`ip:${ip}`, `acct:${ip}:${email}`]) this.fails.set(key, [...this.recent(key, t), t]);
    if (this.fails.size > 10_000) this.prune(t); // bounded memory under a spray of IPs/emails
  }

  succeed(ip: string, email: string): void {
    this.fails.delete(`acct:${ip}:${email}`);
  }

  private recent(key: string, t: number): number[] {
    return (this.fails.get(key) ?? []).filter((x) => x > t - this.windowMs);
  }

  private prune(t: number): void {
    for (const [key, list] of this.fails) {
      const kept = list.filter((x) => x > t - this.windowMs);
      if (kept.length) this.fails.set(key, kept); else this.fails.delete(key);
    }
  }
}
