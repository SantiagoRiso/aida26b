import type { EventApi } from '@fullcalendar/core';
import { appointmentContract, type Appointment } from '@/api/appointments';
import { businessClosureContract, type BusinessClosure } from '@/api/closures';
import { exceptionContract, type ExceptionRow } from '@/composables/scheduleExceptions';

type ExtendedProps = EventApi['extendedProps'];

export function appointmentFromExtendedProps(props: ExtendedProps): Appointment | null {
  return appointmentContract(props.appointment) ? props.appointment : null;
}

export function exceptionFromExtendedProps(props: ExtendedProps): ExceptionRow | null {
  return exceptionContract(props.exception) ? props.exception : null;
}

export function closureFromExtendedProps(props: ExtendedProps): BusinessClosure | null {
  return businessClosureContract(props.closure) ? props.closure : null;
}
