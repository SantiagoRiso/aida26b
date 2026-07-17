import { useForeignKeyOptions } from '@/composables/useForeignKeyOptions';
import { i18n } from '@/i18n';
import type { Appointment } from '@/api/appointments';

export function formatDefaultAppointmentTitle(
  client: string | null,
  resource: string | null,
  service: string | null,
  fallback: string,
  designation: string | null = null,
): string {
  const parts = [client, resource, service, designation].filter((part): part is string => !!part);
  return parts.length ? parts.join(' - ') : fallback;
}

export function useAppointmentLabels() {
  // Untitled appointments read as the client's name, not an opaque "Turno #id".
  const { labelFor: clientLabelFor } = useForeignKeyOptions({
    table: 'clients', valueField: 'id', labelField: 'display_name',
  });
  // DNI disambiguates same-named clients when triaging requests.
  const { labelFor: clientDniFor } = useForeignKeyOptions({
    table: 'clients', valueField: 'id', labelField: 'dni',
  });
  const { labelFor: serviceLabelFor } = useForeignKeyOptions({
    table: 'services', valueField: 'id', labelField: 'name',
  });
  const { labelFor: professionalLabelFor } = useForeignKeyOptions({
    table: 'professionals', valueField: 'id', labelField: 'display_name',
  });
  const { labelFor: resourceLabelFor } = useForeignKeyOptions({
    table: 'resources', valueField: 'id', labelField: 'name',
  });

  function defaultAppointmentTitle(appt: Appointment): string {
    return formatDefaultAppointmentTitle(
      clientLabelFor(appt.client_user_id),
      resourceLabelFor(appt.resource_id),
      serviceLabelFor(appt.service_id),
      i18n.global.t('portal.appointmentFallback', { id: appt.id }),
      appt.override_conflict ? i18n.global.t('calendar.fineMode') : null,
    );
  }

  function apptLabel(appt: Appointment): string {
    return appt.name || defaultAppointmentTitle(appt);
  }

  // Pending requests are triaged by who's asking, so they show the client name-first;
  // the free-text request title is noise here.
  function pendingClientName(appt: Appointment): string {
    return clientLabelFor(appt.client_user_id) ?? appt.name ?? i18n.global.t('portal.appointmentFallback', { id: appt.id });
  }

  function serviceNameFor(appt: Appointment): string | null {
    return serviceLabelFor(appt.service_id);
  }

  // Receptionists see many professionals' turnos — each row must say whose it is.
  function professionalNameFor(appt: Appointment): string | null {
    return professionalLabelFor(appt.professional_user_id);
  }

  function resourceNameFor(appt: Appointment): string | null {
    return resourceLabelFor(appt.resource_id);
  }

  return {
    apptLabel,
    defaultAppointmentTitle,
    pendingClientName,
    clientDniFor,
    serviceNameFor,
    professionalNameFor,
    resourceNameFor,
  };
}
