// Brute-force resistance for the credential endpoints.
//
// Counters live in this process. The app ships as a single backend container (docker-compose.yml
// pins container_name, so there is no replica set to share state across) and the alternative —
// a counter row per attempt — turns every login into a write on the same few hot rows, which is
// the cost a throttle exists to avoid paying. A process restart clears the counters; nothing an
// attacker can reach triggers one. Running more than one backend replica divides every limit
// below by the replica count, so a shared store has to come first if that ever happens.
//
// Attempts are counted per (client, username) and per client, never per account: an account-keyed
// counter would let anyone who can name a user deny that user service, and its state would only
// exist for real accounts, which is exactly the existence oracle login is built to avoid.

export type ThrottleLimit = { key: string; max: number };

export type ThrottleVerdict =
  | { blocked: false }
  | { blocked: true; retryAfterSeconds: number };

export const AUTH_THROTTLE_WINDOW_MS = 15 * 60 * 1000;

// Narrow: a single person fumbling one username. Wide: one client spraying many usernames, which
// is what a harvested user list buys an attacker.
const LOGIN_MAX_PER_IDENTITY = 5;
const LOGIN_MAX_PER_CLIENT = 20;
const PASSWORD_CHANGE_MAX = 5;

// Case-folded so re-capitalising a username does not buy a fresh budget.
export function loginIdentityLimits(client: string, username: string): ThrottleLimit[] {
  return [{ key: `login:${client} ${username.toLowerCase()}`, max: LOGIN_MAX_PER_IDENTITY }];
}

// A success clears only the identity budget, never the per-client one: an attacker holding one
// valid account would otherwise reset their spray allowance at will by logging into it.
export function loginLimits(client: string, username: string): ThrottleLimit[] {
  return [
    ...loginIdentityLimits(client, username),
    { key: `login-client:${client}`, max: LOGIN_MAX_PER_CLIENT },
  ];
}

// Authenticated, so it is not an anonymous guessing surface and stays out of the per-client
// budget: a user mistyping their current password must not throttle logins from their office.
export function passwordChangeLimits(userId: number): ThrottleLimit[] {
  return [{ key: `password-change:${userId}`, max: PASSWORD_CHANGE_MAX }];
}

// Bounds the map against a spray across endlessly many distinct usernames.
const SWEEP_AT_ENTRIES = 2_000;
const MAX_ENTRIES = 10_000;

export class AuthThrottle {
  private readonly attempts = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: { windowMs: number; now?: () => number } = { windowMs: AUTH_THROTTLE_WINDOW_MS }) {
    this.windowMs = options.windowMs;
    this.now = options.now ?? Date.now;
  }

  check(limits: ThrottleLimit[]): ThrottleVerdict {
    const now = this.now();
    let retryAfterMs = 0;

    for (const { key, max } of limits) {
      const hits = this.live(key, now);
      if (hits.length < max) continue;
      // Sliding window: the block lifts once enough of the oldest failures have aged out to bring
      // the count back under the limit, so a client that stops trying is released on its own.
      const releasing = hits[hits.length - max];
      retryAfterMs = Math.max(retryAfterMs, releasing + this.windowMs - now);
    }

    if (retryAfterMs <= 0) return { blocked: false };
    return { blocked: true, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }

  recordFailure(limits: ThrottleLimit[]): void {
    const now = this.now();
    for (const { key } of limits) {
      const hits = this.live(key, now);
      hits.push(now);
      this.attempts.set(key, hits);
    }
    if (this.attempts.size > SWEEP_AT_ENTRIES) this.sweep(now);
  }

  clear(limits: ThrottleLimit[]): void {
    for (const { key } of limits) this.attempts.delete(key);
  }

  reset(): void {
    this.attempts.clear();
  }

  private live(key: string, now: number): number[] {
    const hits = this.attempts.get(key);
    if (!hits) return [];
    const cutoff = now - this.windowMs;
    // Timestamps are appended in order, so the survivors are always a suffix.
    const firstLive = hits.findIndex((at) => at > cutoff);
    if (firstLive === -1) {
      this.attempts.delete(key);
      return [];
    }
    if (firstLive === 0) return hits;
    const pruned = hits.slice(firstLive);
    this.attempts.set(key, pruned);
    return pruned;
  }

  private sweep(now: number): void {
    for (const key of [...this.attempts.keys()]) this.live(key, now);
    if (this.attempts.size <= MAX_ENTRIES) return;
    // Still over cap after dropping everything expired: shed the least recently active keys, the
    // ones furthest from reaching their limit.
    const byRecency = [...this.attempts.entries()]
      .sort((a, b) => a[1][a[1].length - 1] - b[1][b[1].length - 1]);
    for (const [key] of byRecency.slice(0, this.attempts.size - MAX_ENTRIES)) {
      this.attempts.delete(key);
    }
  }
}
