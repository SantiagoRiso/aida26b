import type { Appointment } from '@/api/appointments';
import type { ExceptionRow } from '@/composables/scheduleExceptions';

type ClosurePayload = { id: string; reason: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function isAppointment(value: unknown): value is Appointment {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.client_user_id === 'string'
    && typeof value.professional_user_id === 'string'
    && isNullableString(value.resource_id)
    && typeof value.service_id === 'string'
    && typeof value.starts_at === 'string'
    && typeof value.duration_minutes === 'number'
    && typeof value.ends_at === 'string'
    && typeof value.state === 'string'
    && isNullableString(value.name)
    && isNullableString(value.description)
    && typeof value.price === 'string'
    && typeof value.override_conflict === 'boolean'
    && isNullableString(value.override_actor_id)
    && isNullableString(value.staff_note)
    && typeof value.created_at === 'string'
    && typeof value.updated_at === 'string'
    && typeof value.conflict_ignored === 'boolean'
    && isNullableString(value.series_id)
    && isNullableString(value.occurrence_date)
    && isOptionalBoolean(value.in_conflict)
    && isOptionalBoolean(value.is_virtual);
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
  return isRecord(props) && isAppointment(props.appointment) ? props.appointment : null;
}

export function exceptionFromExtendedProps(props: unknown): ExceptionRow | null {
  return isRecord(props) && isException(props.exception) ? props.exception : null;
}

export function closureFromExtendedProps(props: unknown): ClosurePayload | null {
  return isRecord(props) && isClosure(props.closure) ? props.closure : null;
}
