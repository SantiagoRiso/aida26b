import express from 'express';
import type { ApiEnvelope, ApiError, ApiErrorEnvelope, ListMeta } from '../../shared/src/ssot/envelope';

export function sendList<T>(res: express.Response, data: T[], meta: ListMeta) {
  const payload: ApiEnvelope<T[]> = { success: true, data, meta };
  return res.status(200).json(payload);
}

export function sendData<T>(res: express.Response, data: T, status: number = 200) {
  const payload: ApiEnvelope<T> = { success: true, data };
  return res.status(status).json(payload);
}

export function sendError(
  res: express.Response,
  status: number,
  code: string,
  message: string,
  fields?: Record<string, string>,
) {
  const error: ApiError = { code, message };
  if (fields && Object.keys(fields).length > 0) error.fields = fields;
  const payload: ApiErrorEnvelope = { success: false, error };
  return res.status(status).json(payload);
}
