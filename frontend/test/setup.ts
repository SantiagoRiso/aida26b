import { afterEach } from 'vitest';

// jsdom lacks ResizeObserver, which some form widgets set up on mount. Stub it so component
// mounts don't throw an unhandled error and fail the run.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub;
}

// A GET a test leaves in flight keeps its coalescing key populated, so the next test hitting the
// same path shares that stale promise instead of issuing its own. Clear it after every test so no
// test has to remember. (The FK-options cache is deliberately app-wide and some tests rely on it
// staying warm; those needing a clean slate call resetFkOptionsCache themselves.) Lazy import +
// `in` probe: a test that fully mocks the module has no real singleton, and vitest's mock
// namespace throws on reading an absent export, so `in` gates the call safely.
afterEach(async () => {
  const clientMod = await import('@/api/client');
  if ('resetApiClientState' in clientMod) clientMod.resetApiClientState();
});
