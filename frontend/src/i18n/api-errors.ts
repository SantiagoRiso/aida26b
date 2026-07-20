import { i18n } from '@/i18n';
import type { ErrorDetail } from '@shared/ssot/envelope';
import type { ApiResult } from '@/api/result';

type FailedResult = Extract<ApiResult<never>, { ok: false }>;

function translate(key: string, params?: ErrorDetail['params']): string | undefined {
  const { t, te } = i18n.global;
  if (!te(key)) return undefined;
  return params ? t(key, params) : t(key);
}

// Server prose is English and never shown. Resolution narrows from the endpoint's own key, to the
// error code it shares with every other endpoint, to whatever the screen calls a failed action.
export function apiErrorMessage(result: FailedResult, fallbackKey = 'apiError.fallback'): string {
  const fromDetail = result.detail && translate(`apiError.${result.detail.key}`, result.detail.params);
  return fromDetail
    ?? translate(`apiError.code.${result.code}`)
    ?? i18n.global.t(fallbackKey);
}

export function fieldErrorMessage(detail: ErrorDetail | undefined): string {
  return (detail && translate(`fieldError.${detail.key}`, detail.params))
    ?? i18n.global.t('fieldError.fallback');
}

// Field-level messages for a failed write: the translated per-field map, empty when the endpoint
// reported no field errors.
export function fieldErrorMessages(result: FailedResult): Record<string, string> {
  const names = new Set([
    ...Object.keys(result.fieldDetails ?? {}),
    ...Object.keys(result.fields ?? {}),
  ]);
  const out: Record<string, string> = {};
  for (const name of names) out[name] = fieldErrorMessage(result.fieldDetails?.[name]);
  return out;
}
