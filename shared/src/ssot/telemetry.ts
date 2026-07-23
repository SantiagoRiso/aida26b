// Browser error reports: the narrow set of client-side failures the server cannot otherwise see.
//
// Only failures that indicate a defect are sent. An ordinary 4xx is deliberately excluded: the
// server produced it, already logged it, several already land in audit_events, and it describes
// the user being told something normal rather than the application breaking. Sending those would
// turn every rejected form into a write on a public endpoint.
//
//   render   — an exception escaped a Vue component (the page is broken on screen)
//   promise  — an unhandled rejection (work was abandoned with nobody informed)
//   contract — a response failed its decoder, i.e. client and server disagree about the wire
//              shape; the single most valuable thing the browser can report, because no
//              server-side log can detect it.

export const BROWSER_ERROR_SOURCES = ['render', 'promise', 'contract'] as const;

export type BrowserErrorSource = (typeof BROWSER_ERROR_SOURCES)[number];

export type BrowserErrorReport = {
  source: BrowserErrorSource;
  message: string;
  // Vue's component/hook hint, or the decoder's diagnostic path.
  context?: string;
  // API path and status of a contract failure; absent for render/promise.
  path?: string;
  status?: number;
  // SPA route only. Never the query string: filters carry names, ids and search terms.
  page?: string;
};

// A stack trace is small. Bounding the body is what keeps the endpoint from being a free
// upload slot for anything that can load the page.
export const BROWSER_ERROR_MAX_BODY_BYTES = 4096;
export const BROWSER_ERROR_MAX_FIELD_CHARS = 500;

// Per client, per window. Generous enough for a genuinely broken session, small enough that
// the endpoint cannot be used to flood the log stream.
export const BROWSER_ERROR_MAX_PER_WINDOW = 20;
export const BROWSER_ERROR_WINDOW_MS = 15 * 60 * 1000;

// Second-line defence in the browser itself: a render loop re-throws the same failure on every
// frame, and an honest client should not spend the server's budget on one bug.
export const BROWSER_ERROR_MAX_PER_PAGE_LOAD = 5;

export function isBrowserErrorSource(value: string): value is BrowserErrorSource {
  return (BROWSER_ERROR_SOURCES as readonly string[]).includes(value);
}

export function clipReportField(value: string): string {
  return value.length <= BROWSER_ERROR_MAX_FIELD_CHARS ? value : value.slice(0, BROWSER_ERROR_MAX_FIELD_CHARS);
}
