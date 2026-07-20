import { sendError, type HttpResponse } from '../status_messages';
import type { FieldErrors, FieldIssues } from '../../../shared/src/validation/validate';

// Validation core is shared with the frontend; this module adds the Express-only response helper.
export * from '../../../shared/src/validation/validate';

type Invalid = { fields: FieldErrors; fieldDetails: FieldIssues };

// Returns true on validation failure (after sending the error) so the caller can stop.
export function sendErrorsIfInvalid<T>(
  res: HttpResponse,
  result: { data: T } | Invalid,
): result is Invalid {
  if ('fields' in result) {
    sendError(res, 400, 'validation_error', 'Validation failed', {
      fields: result.fields,
      fieldDetails: result.fieldDetails,
      detail: { key: 'validationFailed' },
    });
    return true;
  }
  return false;
}
