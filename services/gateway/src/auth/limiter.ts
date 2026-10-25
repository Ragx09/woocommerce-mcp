// Login throttling (AUTH-02): failed attempts are counted per client IP and per IP+email; over the limit →
// 429 with Retry-After. The window starts at the first failure (fixed window, ratelimit.ts). The counters
// live in the shared limiter (Postgres in the gateway, F-AUTH-2), so every replica sees the same failures:
// with per-process counters two replicas behind Traefik gave an attacker twice the budget.
// A success clears the IP+email counter.
import { MemoryRateLimiter, type RateLimiter } from '../ratelimit.js';

export interface LimiterOptions {
  windowMs?: number;
  /** Failures allowed per IP+email in the window. */
  perAccount?: number;
  /** Failures allowed per IP (all emails) in the window. */
  perIp?: number;
  /** Shared store; default: this process's memory (tests, single replica). */
  store?: RateLimiter;
  /** Clock for the default memory store (tests). */
  now?: () => number;
}

export class LoginLimiter {
  private readonly store: RateLimiter;
  private readonly windowMs: number;
  private readonly perAccount: number;
  private readonly perIp: number;

  constructor(opts: LimiterOptions = {}) {
    this.windowMs = opts.windowMs ?? 15 * 60_000;
    this.perAccount = opts.perAccount ?? 5;
    this.perIp = opts.perIp ?? 20;
    this.store = opts.store ?? new MemoryRateLimiter(opts.now);
  }

  /** Seconds to wait, or 0 when an attempt is allowed. */
  async retryAfter(ip: string, email: string): Promise<number> {
    const [byIp, byAccount] = await Promise.all([
      this.store.peek(ipBucket(ip), this.perIp, this.windowMs),
      this.store.peek(accountBucket(ip, email), this.perAccount, this.windowMs),
    ]);
    return Math.max(byIp.retryAfterS, byAccount.retryAfterS);
  }

  async fail(ip: string, email: string): Promise<void> {
    await Promise.all([
      this.store.hit(ipBucket(ip), this.perIp, this.windowMs),
      this.store.hit(accountBucket(ip, email), this.perAccount, this.windowMs),
    ]);
  }

  async succeed(ip: string, email: string): Promise<void> {
    await this.store.reset(accountBucket(ip, email));
  }
}

// rate_limits.bucket is at most 200 chars: emails are ≤ 254, so long ones are cut (still per-account in practice).
const ipBucket = (ip: string) => `login:ip:${ip}`.slice(0, 200);
const accountBucket = (ip: string, email: string) => `login:acct:${ip}:${email}`.slice(0, 200);
