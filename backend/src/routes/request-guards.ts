import express from 'express';

import { sendError } from '../status_messages';
import { getServerDerivedFields } from '../../../shared/src/utils/utils';
import { type AuthedRequest } from '../session';
import type { AuthUser } from '../auth';
import type { TableKey, TableRecordMap } from '../../../shared/src/ssot/derived';

// Fail closed: no authenticated user means no authority. A missing req.user must never
// resolve to a privileged identity — defense-in-depth under requireAuth, per handler.
// Responds 401 and returns null when unauthenticated.
export function requireUser(req: express.Request, res: express.Response): AuthUser | null {
  const user = (req as AuthedRequest).user;
  if (!user) {
    sendError(res, 401, 'unauthorized', 'Authentication required');
    return null;
  }
  return user;
}

// Server-stamped (derivable) columns must never be accepted from the request body.
// Responds 422 and returns true when the body carries any.
export function rejectServerDerivedFields(
  res: express.Response,
  table: TableKey,
  body: Partial<TableRecordMap[TableKey]>,
): boolean {
  const serverDerived = new Set(getServerDerivedFields(table));
  const illegalFields = Object.keys(body).filter((k) => serverDerived.has(k));
  if (illegalFields.length === 0) return false;
  sendError(
    res,
    422,
    'server_derived_field',
    'These fields are set by the server and must not be supplied by the client',
    Object.fromEntries(illegalFields.map((f) => [f, 'must not be supplied'])),
  );
  return true;
}
