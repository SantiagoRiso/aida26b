import type { Request } from 'express';
import { optionalAuthenticatedUser } from '../session';
import { sendError, type HttpResponse } from '../status_messages';

export const NO_BUSINESS_CODE = 'no_business';
export const NO_BUSINESS_MESSAGE = 'A business context is required';

// Most routes are tenant-scoped; a null business_id (super-admin) can't satisfy them. Centralizes
// the ~35 inline checks so every denial carries the same code and message.
export function requireBusinessContext(req: Request, res: HttpResponse): number | null {
  const businessId = optionalAuthenticatedUser(req)?.business_id;
  if (businessId == null) {
    sendError(res, 400, NO_BUSINESS_CODE, NO_BUSINESS_MESSAGE);
    return null;
  }
  return businessId;
}

// Rows outside the caller's tenant are invisible: missing, business-less, or cross-business rows
// all fail this check and callers answer 404 (never 403) so existence never leaks.
export function belongsToBusiness<T extends { business_id: string | number | null }>(
  row: T | null | undefined,
  businessId: number,
): row is T {
  return row != null && row.business_id != null && Number(row.business_id) === businessId;
}
