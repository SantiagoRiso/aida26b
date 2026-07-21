import express from 'express';

import { sendError, type HttpResponse } from '../status_messages';
import { getServerDerivedFields } from '../../../shared/src/utils/utils';
import { optionalAuthenticatedUser } from '../session';
import { DATE_RE, DATE_OR_ISO_RE, HHMM_RE } from '../time';
import type { AuthUser } from '../auth';
import type { TableKey } from '../../../shared/src/ssot/derived';
import type { ErrorDetail, ErrorParams } from '../../../shared/src/ssot/envelope';

// Fail closed: no authenticated user means no authority. A missing req.user must never
// resolve to a privileged identity — defense-in-depth under requireAuth, per handler.
// Responds 401 and returns null when unauthenticated.
export function requireUser(req: express.Request, res: HttpResponse): AuthUser | null {
  const user = optionalAuthenticatedUser(req);
  if (!user) {
    sendError(res, 401, 'unauthorized', 'Authentication required');
    return null;
  }
  return user;
}

// eslint-disable-next-line no-restricted-syntax -- Narrows an untrusted request-body field.
export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

// Server-stamped (derivable) columns must never be accepted from the request body.
// Responds 422 and returns true when the body carries any.
export function rejectServerDerivedFields(
  res: HttpResponse,
  table: TableKey,
  body: object,
): boolean {
  const serverDerived = new Set(getServerDerivedFields(table));
  const illegalFields = Object.keys(body).filter((k) => serverDerived.has(k));
  if (illegalFields.length === 0) return false;
  sendError(
    res,
    422,
    'server_derived_field',
    'These fields are set by the server and must not be supplied by the client',
    {
      fields: Object.fromEntries(illegalFields.map((f) => [f, 'must not be supplied'])),
      fieldDetails: Object.fromEntries(illegalFields.map((f) => [f, { key: 'serverDerived' }])),
    },
  );
  return true;
}

// --- Request-shape validation for workflow (protected) routes -------------------------------
//
// A workflow route's body is a verb (reschedule, cancel, materialize), not a table row, so the
// SSOT descriptors cannot describe it. What it CAN share with them is the failure shape: every
// rejected field carries the same stable key + params the column validator emits, so `fieldDetails`
// reaches the browser's fieldError.<key> ladder unchanged, from a route or from a table alike.
// Format facts are imported, never restated — the date/time regexes have one home.

export type RequestFieldValue = string | number | boolean | null | undefined | string[] | object;
export type RequestSource = Record<string, RequestFieldValue>;

type Optionality = { required?: true };

export type RequestFieldSpec =
  | (Optionality & { kind: 'id' })
  | (Optionality & { kind: 'isoDate' })
  | (Optionality & { kind: 'dateOrIso' })
  | (Optionality & { kind: 'timeOfDay' })
  | (Optionality & { kind: 'boolean' })
  | (Optionality & { kind: 'text'; maxLength?: number })
  | (Optionality & { kind: 'enum'; values: readonly string[] })
  | (Optionality & { kind: 'pattern'; pattern: RegExp; key: string });

export type RequestSpec = Record<string, RequestFieldSpec>;

type SpecValue<S extends RequestFieldSpec> =
  S extends { kind: 'id' } ? number
    : S extends { kind: 'boolean' } ? boolean
      : S extends { kind: 'enum'; values: readonly (infer V extends string)[] } ? V
        : string;

// An omitted optional field reads as undefined; a required one is present or the request failed.
export type RequestValues<S extends RequestSpec> = {
  [K in keyof S]: S[K] extends { required: true } ? SpecValue<S[K]> : SpecValue<S[K]> | undefined;
};

// Two projections of one rule, as in the shared column validator: English prose for logs and
// non-browser consumers, a stable key for a localized UI.
export type RequestIssue = { issue: ErrorDetail; message: string };
export type RequestIssues = Record<string, RequestIssue>;

export function requestIssue(key: string, message: string, params?: ErrorParams): RequestIssue {
  return { issue: params ? { key, params } : { key }, message };
}

type FieldOutcome = { value: string | number | boolean } | { issue: RequestIssue } | 'absent';

function checkField(field: string, spec: RequestFieldSpec, raw: RequestFieldValue): FieldOutcome {
  // A repeated query param arrives as an array; the routes all read single-valued params.
  const value = Array.isArray(raw) ? raw[0] : raw;

  // A blank string is "not supplied" for every typed field. Free text is the exception: clearing
  // a note is a real edit, so '' stays a value there unless the field is required.
  const blank = value === undefined || value === null
    || (value === '' && (spec.kind !== 'text' || spec.required === true));
  if (blank) {
    return spec.required ? { issue: requestIssue('required', `${field} is required`) } : 'absent';
  }

  switch (spec.kind) {
    case 'id': {
      const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
      if (!Number.isInteger(n) || n <= 0) {
        return { issue: requestIssue('positiveInteger', `${field} must be a positive integer`) };
      }
      return { value: n };
    }
    case 'boolean':
      if (typeof value === 'boolean') return { value };
      if (value === 'true') return { value: true };
      if (value === 'false') return { value: false };
      return { issue: requestIssue('notBoolean', `${field} must be a boolean`) };
    case 'isoDate':
      if (typeof value !== 'string' || !DATE_RE.test(value)) {
        return { issue: requestIssue('dateFormat', `${field} must be YYYY-MM-DD`) };
      }
      return { value };
    case 'dateOrIso':
      if (typeof value !== 'string' || !DATE_OR_ISO_RE.test(value)) {
        return { issue: requestIssue('dateFormat', `${field} must be a date (YYYY-MM-DD) or an ISO timestamp`) };
      }
      return { value };
    case 'timeOfDay':
      if (typeof value !== 'string' || !HHMM_RE.test(value)) {
        return { issue: requestIssue('timeOfDayFormat', `${field} must be HH:MM`) };
      }
      return { value };
    case 'text': {
      if (typeof value !== 'string') return { issue: requestIssue('notString', `${field} must be a string`) };
      if (spec.maxLength !== undefined && value.length > spec.maxLength) {
        return {
          issue: requestIssue('maxLength', `${field} must be at most ${spec.maxLength} characters`, { max: spec.maxLength }),
        };
      }
      return { value };
    }
    case 'enum': {
      if (typeof value !== 'string' || !spec.values.includes(value)) {
        const options = spec.values.join(', ');
        return { issue: requestIssue('notInOptions', `${field} must be one of: ${options}`, { options }) };
      }
      return { value };
    }
    case 'pattern':
      if (typeof value !== 'string' || !spec.pattern.test(value)) {
        return { issue: requestIssue(spec.key, `${field} has an invalid format`) };
      }
      return { value };
  }
}

// Coerces and checks a whole request shape at once. `values` is only meaningful when `issues` is
// empty — callers that need to merge issues across two specs check that themselves; everyone else
// wants requireRequestFields, which cannot hand back unchecked values.
export function parseRequestFields<S extends RequestSpec>(
  spec: S,
  source: RequestSource | undefined,
): { values: RequestValues<S>; issues: RequestIssues } {
  const src = source ?? {};
  const values: Record<string, string | number | boolean | undefined> = {};
  const issues: RequestIssues = {};

  for (const [field, fieldSpec] of Object.entries(spec)) {
    const outcome = checkField(field, fieldSpec, src[field]);
    if (outcome === 'absent') values[field] = undefined;
    else if ('issue' in outcome) issues[field] = outcome.issue;
    else values[field] = outcome.value;
  }

  return { values: values as object as RequestValues<S>, issues };
}

export function sendFieldIssues(res: HttpResponse, message: string, issues: RequestIssues): void {
  sendError(res, 422, 'invalid_request', message, {
    fields: Object.fromEntries(Object.entries(issues).map(([field, i]) => [field, i.message])),
    fieldDetails: Object.fromEntries(Object.entries(issues).map(([field, i]) => [field, i.issue])),
  });
}

// Responds 422 with per-field keys and returns null when the shape is wrong.
export function requireRequestFields<S extends RequestSpec>(
  res: HttpResponse,
  spec: S,
  source: RequestSource | undefined,
  message: string,
): RequestValues<S> | null {
  const { values, issues } = parseRequestFields(spec, source);
  if (Object.keys(issues).length > 0) {
    sendFieldIssues(res, message, issues);
    return null;
  }
  return values;
}

const ID_PARAM_SPEC = { id: { kind: 'id', required: true } } as const satisfies RequestSpec;

// A malformed :id is a bad URL, not a bad form field — it carries a top-level detail key so the
// client can translate it without pinning an error to a field that isn't on screen.
export function requireIdParam(res: HttpResponse, raw: RequestFieldValue, entity: string): number | null {
  const { values, issues } = parseRequestFields(ID_PARAM_SPEC, { id: raw });
  if (issues.id) {
    sendError(res, 422, 'invalid_request', `Invalid ${entity} id`, { detail: { key: 'invalidId' } });
    return null;
  }
  return values.id;
}
