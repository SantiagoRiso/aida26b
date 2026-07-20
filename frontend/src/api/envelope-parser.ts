import type { ApiEnvelope, ApiErrorEnvelope, ErrorDetail, ErrorParams, ListMeta } from '@shared/ssot/envelope';
import { isUnknownRecord } from '@/api/decoders';

// eslint-disable-next-line no-restricted-syntax -- Successful envelope data remains untrusted until endpoint validation.
export type UntrustedEnvelope = ApiEnvelope<unknown> | ApiErrorEnvelope;

// eslint-disable-next-line no-restricted-syntax -- Narrows an untrusted envelope error field.
function isStringRecord(value: unknown): value is Record<string, string> {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value).every((item) => typeof item === 'string');
}

// A malformed detail is dropped rather than rejecting the envelope: the error still has a code
// and prose, so the caller degrades to a coarser message instead of losing the failure entirely.
// eslint-disable-next-line no-restricted-syntax -- Narrows an untrusted envelope error field.
function toErrorDetail(value: unknown): ErrorDetail | undefined {
  if (!isUnknownRecord(value) || typeof value.key !== 'string') return undefined;
  if (!('params' in value) || value.params === undefined) return { key: value.key };
  if (!isUnknownRecord(value.params)) return { key: value.key };
  const params: ErrorParams = {};
  for (const [name, item] of Object.entries(value.params)) {
    if (typeof item === 'string' || typeof item === 'number') params[name] = item;
  }
  return { key: value.key, params };
}

// eslint-disable-next-line no-restricted-syntax -- Narrows an untrusted envelope error field.
function toErrorDetails(value: unknown): Record<string, ErrorDetail> | undefined {
  if (!isUnknownRecord(value)) return undefined;
  const out: Record<string, ErrorDetail> = {};
  for (const [field, item] of Object.entries(value)) {
    const detail = toErrorDetail(item);
    if (detail) out[field] = detail;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// eslint-disable-next-line no-restricted-syntax -- Narrows untrusted envelope pagination metadata.
function isListMeta(value: unknown): value is ListMeta {
  return isUnknownRecord(value)
    && typeof value.page === 'number'
    && typeof value.limit === 'number'
    && typeof value.total === 'number';
}

// eslint-disable-next-line no-restricted-syntax -- Entry point for response.json data.
export function parseEnvelope(value: unknown): UntrustedEnvelope | null {
  if (!isUnknownRecord(value)) return null;
  if (value.success === true) {
    if (!('data' in value)) return null;
    if ('meta' in value && value.meta !== undefined && !isListMeta(value.meta)) return null;
    return { success: true, data: value.data, ...(isListMeta(value.meta) ? { meta: value.meta } : {}) };
  }
  if (value.success !== false || !isUnknownRecord(value.error)) return null;
  const error = value.error;
  if (typeof error.code !== 'string' || typeof error.message !== 'string') return null;
  if ('fields' in error && error.fields !== undefined && !isStringRecord(error.fields)) return null;
  const detail = toErrorDetail(error.detail);
  const fieldDetails = toErrorDetails(error.fieldDetails);
  return {
    success: false,
    error: {
      code: error.code,
      message: error.message,
      ...(detail ? { detail } : {}),
      ...(isStringRecord(error.fields) ? { fields: error.fields } : {}),
      ...(fieldDetails ? { fieldDetails } : {}),
    },
  };
}
