import type { ApiEnvelope, ApiError, ApiErrorEnvelope, ListMeta } from '../../shared/src/ssot/envelope';

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

export function sendError(
  res: HttpResponse,
  status: number,
  code: string,
  message: string,
  fields?: Record<string, string>,
) {
  const error: ApiError = { code, message };
  if (fields && Object.keys(fields).length > 0) error.fields = fields;
  const payload: ApiErrorEnvelope = { success: false, error };
  res.status(status).json(payload);
}
