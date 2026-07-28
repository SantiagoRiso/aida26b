import { useI18n } from 'vue-i18n';
import { useLabel } from '@/composables/useLabel';
import { useStateLabel } from '@/composables/useStateLabel';
import { tableOf } from '@shared/utils/utils';
import type { ColumnValue } from '@shared/types/types';
import type { AuditEvent } from '@/api/audit';

type AuditDetails = NonNullable<AuditEvent['details']>;
type AuditDetailValue = AuditDetails[string];

// Keys already represented by their own column: entity_type/entity_id are the Entity cell, user_id
// repeats entity_id, business_id repeats the tenant column. Showing them again would just echo
// what the row already says.
const SUPPRESSED_DETAIL_KEYS = new Set<string>(['entity_type', 'entity_id', 'user_id', 'business_id']);

// Denial reasons with no apiError.code.* entry: the HTTP error code sent to the client is
// coarser ('forbidden') than the reason recorded in the audit trail.
const REASON_KEY_OVERRIDES: Record<string, string> = {
  role_forbidden: 'apiError.insufficientRole',
  own_calendar_only: 'apiError.grantOwnCalendarOnly',
};

// Business-facing labels for the detail keys writers actually stamp. An unlisted key still
// renders under its own raw name rather than being dropped, so a new write site is visible
// immediately, before anyone adds a label here.
const DETAIL_KEY_LABEL_KEYS: Record<string, string> = {
  reason: 'audit.details.reasonLabel',
  username: 'audit.details.usernameLabel',
  fields: 'audit.details.fieldsLabel',
  path: 'audit.details.pathLabel',
  method: 'audit.details.methodLabel',
  role: 'audit.details.roleLabel',
  operation: 'audit.details.operationLabel',
  count: 'audit.details.countLabel',
  canceled: 'audit.details.canceledLabel',
  professional_user_id: 'audit.details.professionalIdLabel',
  cancellation_cutoff_hours: 'business.cancellationCutoff',
  min_booking_days: 'business.minBookingDays',
  max_booking_days: 'business.maxBookingDays',
};

export interface AuditDetailEntry {
  key: string;
  label: string;
  text: string;
}

export function useAuditDetails() {
  const { t, te } = useI18n();
  const { label } = useLabel();
  const { roleLabel } = useStateLabel();

  function scalarText(value: ColumnValue): string {
    if (value === null) return '';
    if (typeof value === 'boolean') return value ? t('generic.yes') : t('generic.no');
    if (value instanceof Date) return value.toISOString();
    return String(value);
  }

  function reasonText(value: AuditDetailValue): string {
    if (typeof value !== 'string') return defaultText(value);
    const overrideKey = REASON_KEY_OVERRIDES[value];
    if (overrideKey && te(overrideKey)) return t(overrideKey);
    const codeKey = `apiError.code.${value}`;
    if (te(codeKey)) return t(codeKey);
    return value;
  }

  function operationText(value: AuditDetailValue): string {
    if (typeof value !== 'string') return defaultText(value);
    const key = `audit.details.operationValue.${value}`;
    return te(key) ? t(key) : value;
  }

  function fieldsText(value: AuditDetailValue): string {
    const values = Array.isArray(value) ? value : [value];
    return values
      .map((entry) => {
        if (typeof entry !== 'string') return scalarText(entry);
        const column = tableOf('appointments').columns[entry];
        return column?.label ? label(column.label) : entry;
      })
      .join(', ');
  }

  function roleText(value: AuditDetailValue): string {
    return typeof value === 'string' ? roleLabel(value) : defaultText(value);
  }

  function defaultText(value: AuditDetailValue): string {
    if (Array.isArray(value)) return value.map(scalarText).filter((v) => v !== '').join(', ');
    return scalarText(value);
  }

  const VALUE_FORMATTERS: Record<string, (value: AuditDetailValue) => string> = {
    reason: reasonText,
    operation: operationText,
    fields: fieldsText,
    role: roleText,
  };

  function keyLabel(keyName: string): string {
    const labelKey = DETAIL_KEY_LABEL_KEYS[keyName];
    return labelKey ? t(labelKey) : keyName;
  }

  // Free-form JSON from the server: never assume a shape beyond scalar or scalar[], and never
  // throw on a value this function doesn't know about.
  function auditDetailEntries(details: AuditEvent['details']): AuditDetailEntry[] {
    if (!details) return [];
    const entries: AuditDetailEntry[] = [];
    for (const [keyName, value] of Object.entries(details)) {
      if (SUPPRESSED_DETAIL_KEYS.has(keyName) || value == null) continue;
      const formatter = VALUE_FORMATTERS[keyName] ?? defaultText;
      const text = formatter(value);
      if (text === '') continue;
      entries.push({ key: keyName, label: keyLabel(keyName), text });
    }
    return entries;
  }

  return { auditDetailEntries };
}
