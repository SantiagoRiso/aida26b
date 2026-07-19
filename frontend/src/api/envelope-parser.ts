import type { ApiEnvelope, ApiErrorEnvelope, ListMeta } from '@shared/ssot/envelope';
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
  return {
    success: false,
    error: {
      code: error.code,
      message: error.message,
      ...(isStringRecord(error.fields) ? { fields: error.fields } : {}),
    },
  };
}
