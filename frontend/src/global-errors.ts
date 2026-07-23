import type { App } from 'vue';
import { API_PREFIX, telemetryPaths } from '@shared/ssot/api-paths';
import { BROWSER_ERROR_MAX_PER_PAGE_LOAD, clipReportField } from '@shared/ssot/telemetry';
import type { BrowserErrorReport } from '@shared/ssot/telemetry';
import { setApiContractFailureReporter } from '@/api/contract-validation';

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

// One budget per page load, so a component that re-throws on every frame costs one report, not
// one per frame. Identical failures are collapsed: the second occurrence teaches nobody anything.
function createBrowserErrorSender(): (report: BrowserErrorReport) => void {
  const seen = new Set<string>();

  return (report) => {
    const fingerprint = `${report.source}|${report.message}|${report.path ?? ''}`;
    if (seen.has(fingerprint) || seen.size >= BROWSER_ERROR_MAX_PER_PAGE_LOAD) return;
    seen.add(fingerprint);

    const body: BrowserErrorReport = {
      source: report.source,
      message: clipReportField(report.message),
      // Route only. The query string carries filters, search terms and ids.
      page: window.location.pathname,
    };
    if (report.context !== undefined) body.context = clipReportField(report.context);
    if (report.path !== undefined) body.path = clipReportField(report.path);
    if (report.status !== undefined) body.status = report.status;

    try {
      // keepalive: the failures worth reporting are the ones followed by a reload or a navigation.
      void fetch(`${API_PREFIX}${telemetryPaths.browserError()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'same-origin',
        keepalive: true,
      }).catch(() => { /* a report that fails to send must not become a second failure */ });
    } catch { /* same */ }
  };
}

// Ordinary 4xx answers never reach either reporter: the api client returns them as results
// before the contract validator runs, so what is sent here is only what indicates a defect.
export function installErrorTelemetry(): () => void {
  const send = createBrowserErrorSender();

  const restoreUncaught = setUncaughtFailureReporter((failure) => {
    if (import.meta.env.DEV) console.error('uncaught_error', failure);
    send({ source: failure.source, message: failure.message, context: failure.info });
  });

  const restoreContract = setApiContractFailureReporter((failure) => {
    if (import.meta.env.DEV) console.error('api_contract_failure', failure);
    send({
      source: 'contract',
      message: failure.diagnostic,
      path: failure.path,
      status: failure.status,
    });
  });

  return () => { restoreContract(); restoreUncaught(); };
}
