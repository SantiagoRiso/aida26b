import type { ApiEnvelope, ApiError, ApiErrorEnvelope, ErrorDetail, ListMeta } from '../../shared/src/ssot/envelope';

export interface HttpResponse {
  status(code: number): HttpResponse;
  json(payload: object): HttpResponse;
}

export function sendList<T>(res: HttpResponse, data: T[], meta: ListMeta) {
  const payload: ApiEnvelope<T[]> = { success: true, data, meta };
  res.status(200).json(payload);
}

export function sendData<T>(res: HttpResponse, data: T, status: number = 200) {
  const payload: ApiEnvelope<T> = { success: true, data };
  res.status(status).json(payload);
}

// `detail`/`fieldDetails` are optional: an error without them still carries English prose, and
// the client degrades to translating the code.
type ErrorExtrasFields = {
  fields?: Record<string, string>;
  detail?: ErrorDetail;
  fieldDetails?: Record<string, ErrorDetail>;
};

// Every branch names at least one of the three known keys, so a bare Record<string, string> passed
// where callers meant `{ fields: someMap }` has no named property to match and fails to compile,
// instead of silently satisfying an all-optional shape and getting dropped. The value side stays
// `| undefined` because callers narrow it from an already-optional field (e.g. a loader result).
export type ErrorExtras =
  | Record<string, never>
  | (ErrorExtrasFields & { fields: Record<string, string> | undefined })
  | (ErrorExtrasFields & { detail: ErrorDetail | undefined })
  | (ErrorExtrasFields & { fieldDetails: Record<string, ErrorDetail> | undefined });

export function sendError(
  res: HttpResponse,
  status: number,
  code: string,
  message: string,
  extras: ErrorExtras = {},
) {
  const { fields, detail, fieldDetails } = extras;
  const error: ApiError = { code, message };
  if (detail) error.detail = detail;
  if (fields && Object.keys(fields).length > 0) error.fields = fields;
  if (fieldDetails && Object.keys(fieldDetails).length > 0) error.fieldDetails = fieldDetails;
  const payload: ApiErrorEnvelope = { success: false, error };
  res.status(status).json(payload);
}
