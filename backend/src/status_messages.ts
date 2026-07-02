import express from 'express';

export type ListMeta = { page: number; limit: number; total: number };

export function sendList(res: express.Response, data: unknown[], meta: ListMeta) {
  return res.status(200).json({ success: true, data, meta });
}

export function sendData(res: express.Response, data: unknown, status: number = 200) {
  return res.status(status).json({ success: true, data });
}

export function sendError(
  res: express.Response,
  status: number,
  code: string,
  message: string,
  fields?: Record<string, string>,
) {
  const error: { code: string; message: string; fields?: Record<string, string> } = { code, message };
  if (fields && Object.keys(fields).length > 0) error.fields = fields;
  return res.status(status).json({ success: false, error });
}
