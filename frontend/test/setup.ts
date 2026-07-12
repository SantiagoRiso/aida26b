// jsdom lacks ResizeObserver, which some form widgets set up on mount. Stub it so component
// mounts don't throw an unhandled error and fail the run.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (!('ResizeObserver' in globalThis)) {
  (globalThis as { ResizeObserver?: typeof ResizeObserverStub }).ResizeObserver = ResizeObserverStub;
}
