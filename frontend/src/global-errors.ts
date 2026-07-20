import type { App } from 'vue';

export type UncaughtFailure = { source: 'render' | 'promise'; message: string; info?: string };
type UncaughtFailureReporter = (failure: UncaughtFailure) => void;

// Swappable so a test (or a future collector) can observe what escaped instead of the console.
let uncaughtFailureReporter: UncaughtFailureReporter = (failure) => {
  console.error('uncaught_error', failure);
};

export function setUncaughtFailureReporter(reporter: UncaughtFailureReporter): () => void {
  const previous = uncaughtFailureReporter;
  uncaughtFailureReporter = reporter;
  return () => { uncaughtFailureReporter = previous; };
}

// eslint-disable-next-line no-restricted-syntax -- A thrown value or rejection reason is whatever the thrower chose.
function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  return Object.prototype.toString.call(value);
}

// Escaped errors are bugs, not user-actionable conditions: they are recorded, never toasted. An
// operation the user actually triggered reports its own failure through the api result it awaited.
export function installGlobalErrorHandlers(app: App): void {
  app.config.errorHandler = (error, _instance, info) => {
    uncaughtFailureReporter({ source: 'render', message: describe(error), info });
  };
  window.addEventListener('unhandledrejection', (event) => {
    uncaughtFailureReporter({ source: 'promise', message: describe(event.reason) });
  });
}
