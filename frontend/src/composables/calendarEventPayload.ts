import { appointmentContract, type Appointment } from '@/api/appointments';
import type { ExceptionRow } from '@/composables/scheduleExceptions';

type ClosurePayload = { id: string; reason: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isException(value: unknown): value is ExceptionRow {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && isNullableString(value.professional_user_id)
    && isNullableString(value.resource_id)
    && isNullableString(value.business_id)
    && typeof value.exception_date === 'string'
    && (value.is_unavailable === null || typeof value.is_unavailable === 'boolean')
    && isNullableString(value.start_time)
    && isNullableString(value.end_time)
    && (value.granularity_minutes === null || typeof value.granularity_minutes === 'number')
    && isNullableString(value.reason);
}

function isClosure(value: unknown): value is ClosurePayload {
  return isRecord(value) && typeof value.id === 'string' && isNullableString(value.reason);
}

export function appointmentFromExtendedProps(props: unknown): Appointment | null {
  return isRecord(props) && appointmentContract(props.appointment) ? props.appointment : null;
}

export function exceptionFromExtendedProps(props: unknown): ExceptionRow | null {
  return isRecord(props) && isException(props.exception) ? props.exception : null;
}

export function closureFromExtendedProps(props: unknown): ClosurePayload | null {
  return isRecord(props) && isClosure(props.closure) ? props.closure : null;
}
