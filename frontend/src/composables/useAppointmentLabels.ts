import { useForeignKeyOptions } from '@/composables/useForeignKeyOptions';
import { useAuthStore } from '@/stores/auth';
import { i18n } from '@/i18n';
import type { Appointment } from '@/api/appointments';
import { appointmentName } from '@shared/ssot/domain/naming';

// Thin adapter over the shared rule: the audit log names a turno with the same function, so the
// two cannot drift into different ideas of what a turno is called.
export function formatDefaultAppointmentTitle(
  client: string | null,
  resource: string | null,
  service: string | null,
  professional: string | null,
  fallback: string,
  designation: string | null = null,
): string {
  return appointmentName({ client, resource, service, professional, designation }, fallback);
}

export function useAppointmentLabels() {
  const auth = useAuthStore();

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

  // client_user_id/professional_user_id/service_id are all NOT NULL FKs, so the server now joins
  // their names directly onto the appointment payload (list/detail reads): reading appt.*_name
  // first means the title never depends on the FK-options cache having loaded yet. The labelFor
  // calls stay as a fallback for the rare payload that lacks them (a mutation response, which
  // returns the bare RETURNING * row rather than the joined read shape).
  function defaultAppointmentTitle(appt: Appointment): string {
    const viewer = auth.user;
    // A Professional viewing their own calendar already knows whose calendar it is; appending
    // their own name to every event would be pure noise, not information.
    const ownAppointment = viewer?.role === 'Professional' && String(viewer.id) === String(appt.professional_user_id);
    const professional = ownAppointment
      ? null
      : (appt.professional_name ?? professionalLabelFor(appt.professional_user_id));
    return formatDefaultAppointmentTitle(
      appt.client_name ?? clientLabelFor(appt.client_user_id),
      resourceLabelFor(appt.resource_id),
      appt.service_name ?? serviceLabelFor(appt.service_id),
      professional,
      i18n.global.t('portal.appointmentFallback'),
      appt.override_conflict ? i18n.global.t('calendar.fineMode') : null,
    );
  }

  function apptLabel(appt: Appointment): string {
    return appt.name || defaultAppointmentTitle(appt);
  }

  // Pending requests are triaged by who's asking, so they show the client name-first;
  // the free-text request title is noise here.
  function pendingClientName(appt: Appointment): string {
    return appt.client_name ?? clientLabelFor(appt.client_user_id) ?? appt.name ?? i18n.global.t('portal.appointmentFallback');
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
