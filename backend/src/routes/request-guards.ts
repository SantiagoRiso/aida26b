import express from 'express';

import { sendError, type HttpResponse } from '../status_messages';
import { getServerDerivedFields } from '../../../shared/src/utils/utils';
import { optionalAuthenticatedUser } from '../session';
import type { AuthUser } from '../auth';
import type { TableKey } from '../../../shared/src/ssot/derived';

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
