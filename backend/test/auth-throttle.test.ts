import { describe, it, expect } from 'vitest';
import {
  AuthThrottle,
  loginIdentityLimits,
  loginLimits,
  passwordChangeLimits,
  AUTH_THROTTLE_WINDOW_MS,
} from '../src/auth-throttle';

// A controllable clock, so "the window elapsed" is asserted rather than waited for.
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function makeThrottle(windowMs = 1000) {
  const clock = fakeClock();
  return { throttle: new AuthThrottle({ windowMs, now: clock.now }), clock, windowMs };
}

const CLIENT = '203.0.113.7';

describe('AuthThrottle sliding window', () => {
  it('allows attempts up to the limit and blocks the next one', () => {
    const { throttle } = makeThrottle();
    const limits = loginLimits(CLIENT, 'someone');

    for (let i = 0; i < 5; i++) {
      expect(throttle.check(limits).blocked).toBe(false);
      throttle.recordFailure(limits);
    }

    expect(throttle.check(limits).blocked).toBe(true);
  });

  it('releases once the oldest counted failure ages out of the window', () => {
    const { throttle, clock, windowMs } = makeThrottle();
    const limits = loginLimits(CLIENT, 'someone');

    for (let i = 0; i < 5; i++) throttle.recordFailure(limits);
    expect(throttle.check(limits).blocked).toBe(true);

    // Still inside the window: the block must hold, not decay early.
    clock.advance(windowMs - 1);
    expect(throttle.check(limits).blocked).toBe(true);

    clock.advance(2);
    expect(throttle.check(limits).blocked).toBe(false);
  });

  it('reports a retry-after that expires with the window', () => {
    const { throttle, clock, windowMs } = makeThrottle(60_000);
    const limits = loginLimits(CLIENT, 'someone');

    for (let i = 0; i < 5; i++) throttle.recordFailure(limits);
    clock.advance(20_000);

    const verdict = throttle.check(limits);
    expect(verdict.blocked).toBe(true);
    if (!verdict.blocked) return;
    expect(verdict.retryAfterSeconds).toBe((windowMs - 20_000) / 1000);
  });

  it('counts a spray across many usernames against the per-client budget', () => {
    const { throttle } = makeThrottle();

    // Four failures each on five different usernames: none reaches the per-identity limit of 5,
    // but together they exceed the per-client limit of 20.
    for (let u = 0; u < 5; u++) {
      const limits = loginLimits(CLIENT, `victim_${u}`);
      for (let i = 0; i < 4; i++) throttle.recordFailure(limits);
    }

    expect(throttle.check(loginLimits(CLIENT, 'victim_0')).blocked).toBe(true);
    // A username never tried before is blocked too — the budget belongs to the client.
    expect(throttle.check(loginLimits(CLIENT, 'untouched')).blocked).toBe(true);
    // A different client is unaffected.
    expect(throttle.check(loginLimits('198.51.100.4', 'victim_0')).blocked).toBe(false);
  });

  it('keys on the client, so one client cannot throttle another for the same username', () => {
    const { throttle } = makeThrottle();
    const attacker = loginLimits(CLIENT, 'target');

    for (let i = 0; i < 5; i++) throttle.recordFailure(attacker);

    expect(throttle.check(attacker).blocked).toBe(true);
    expect(throttle.check(loginLimits('198.51.100.4', 'target')).blocked).toBe(false);
  });

  it('folds case so re-capitalising a username does not buy a fresh budget', () => {
    const { throttle } = makeThrottle();

    for (let i = 0; i < 5; i++) throttle.recordFailure(loginLimits(CLIENT, 'target'));

    expect(throttle.check(loginLimits(CLIENT, 'TARGET')).blocked).toBe(true);
  });

  it('clears the identity budget on success while the per-client budget keeps accruing', () => {
    const { throttle } = makeThrottle();

    // Five rounds of (4 failures, then a success on that username). The identity budget is wiped
    // each round, so no username ever reaches 5 — but 20 failures still land on the client.
    for (let u = 0; u < 5; u++) {
      const limits = loginLimits(CLIENT, `victim_${u}`);
      for (let i = 0; i < 4; i++) {
        expect(throttle.check(limits).blocked).toBe(false);
        throttle.recordFailure(limits);
      }
      throttle.clear(loginIdentityLimits(CLIENT, `victim_${u}`));
    }

    expect(throttle.check(loginLimits(CLIENT, 'victim_0')).blocked).toBe(true);
  });

  it('tracks password changes per user, independent of the login budget', () => {
    const { throttle } = makeThrottle();
    const pwLimits = passwordChangeLimits(42);

    for (let i = 0; i < 5; i++) throttle.recordFailure(pwLimits);

    expect(throttle.check(pwLimits).blocked).toBe(true);
    expect(throttle.check(passwordChangeLimits(43)).blocked).toBe(false);
    expect(throttle.check(loginLimits(CLIENT, 'anyone')).blocked).toBe(false);
  });

  it('defaults to the production window when constructed with no options', () => {
    const throttle = new AuthThrottle();
    const limits = loginLimits(CLIENT, 'someone');
    for (let i = 0; i < 5; i++) throttle.recordFailure(limits);

    const verdict = throttle.check(limits);
    expect(verdict.blocked).toBe(true);
    if (!verdict.blocked) return;
    expect(verdict.retryAfterSeconds).toBeGreaterThan(AUTH_THROTTLE_WINDOW_MS / 1000 - 5);
  });

  it('does not accumulate keys for clients whose failures have all expired', () => {
    const { throttle, clock, windowMs } = makeThrottle();

    for (let u = 0; u < 1200; u++) throttle.recordFailure(loginLimits(`10.0.0.${u}`, `u${u}`));
    clock.advance(windowMs + 1);
    // The sweep runs on write; one more failure past the threshold collapses the expired keys.
    throttle.recordFailure(loginLimits('10.1.0.1', 'fresh'));

    expect(throttle.check(loginLimits('10.0.0.0', 'u0')).blocked).toBe(false);
  });
});
