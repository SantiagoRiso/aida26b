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

// Back-compat wrappers so existing callers keep compiling. Prefer sendData/sendList/sendError.
function sendErrorMessage(res: express.Response, responseMessage: string) {
  return sendError(res, 500, 'internal_error', responseMessage);
}

function sendSuccessOperationMessage(
  res: express.Response,
  _entityName: string,
  data: any,
  _operationDone: string,
  successCode: number,
) {
  return sendData(res, data, successCode);
}

function sendInvalidInstanceMessage(res: express.Response, message: string) {
  return sendError(res, 400, 'invalid_request', message);
}

function sendNotFoundMessage(res: express.Response, message: string) {
  return sendError(res, 404, 'not_found', `${message} not found`);
}

export { sendErrorMessage, sendInvalidInstanceMessage, sendNotFoundMessage, sendSuccessOperationMessage };
