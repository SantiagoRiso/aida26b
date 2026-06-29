import type { Response } from 'express';
import { sendError } from '../status_messages';
import type { FieldErrors } from '../../../shared/src/validation/validate';

// Validation core is shared with the frontend; this module adds the Express-only response helper.
export * from '../../../shared/src/validation/validate';

// Returns true on validation failure (after sending the error) so the caller can stop.
export function sendErrorsIfInvalid<T>(
  res: Response,
  result: { data: T } | { errors: string[]; fields: FieldErrors },
): result is { errors: string[]; fields: FieldErrors } {
  if ('errors' in result) {
    sendError(res, 400, 'validation_error', 'Validation failed', result.fields);
    return true;
  }
  return false;
}
