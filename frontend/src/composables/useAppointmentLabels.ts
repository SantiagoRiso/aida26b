import { useForeignKeyOptions } from '@/composables/useForeignKeyOptions';
import { i18n } from '@/i18n';
import type { Appointment } from '@/api/appointments';

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

  function apptLabel(appt: Appointment): string {
    if (appt.name) return appt.name;
    return clientLabelFor(appt.client_user_id) ?? i18n.global.t('portal.appointmentFallback', { id: appt.id });
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

  return { apptLabel, pendingClientName, clientDniFor, serviceNameFor, professionalNameFor };
}
