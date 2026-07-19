import { ref, computed } from 'vue';
import { listAppointments, transitionAppointment } from '@/api/appointments';
import type { Appointment } from '@/api/appointments';
import { isVirtualOccurrence } from '@/composables/seriesOccurrence';
import { isOpenAppointmentState } from '@shared/ssot/domain';
import { useToast } from '@/composables/useToast';

export function useClientAppointments(clientId: number) {
  const toast = useToast();

  const appointments = ref<Appointment[]>([]);

  async function loadAppointments() {
    const res = await listAppointments({ client_user_id: clientId, limit: 500 });
    // This list's cancel action reads appt.id directly (no materialize-on-action wiring here),
    // so a virtual (un-materialized) occurrence is filtered out rather than shown as inert.
    appointments.value = res.ok ? res.data.filter((a): a is Appointment => !isVirtualOccurrence(a)) : [];
  }

  // Pending = still actionable (requested or scheduled); these can be cancelled.
  const pendingAppointments = computed(() =>
    appointments.value
      .filter((a) => isOpenAppointmentState(a.state))
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
  );

  // Closed/past appointments only — the pending ones are already shown in the "Pendientes"
  // list above, so the history table must not repeat them.
  const historyAppointments = computed(() =>
    appointments.value
      .filter((a) => !isOpenAppointmentState(a.state))
      .sort((a, b) => b.starts_at.localeCompare(a.starts_at)),
  );

  const cancelId = ref<number | string | null>(null);
  const cancelConfirmOpen = ref(false);

  function requestCancel(id: number | string) {
    cancelId.value = id;
    cancelConfirmOpen.value = true;
  }

  async function confirmCancel() {
    cancelConfirmOpen.value = false;
    if (cancelId.value == null) return;
    const res = await transitionAppointment(cancelId.value, 'canceled');
    cancelId.value = null;
    if (res.ok) {
      toast.success('appointmentCanceled');
      void loadAppointments();
    } else {
      toast.error('genericError');
    }
  }

  return {
    appointments,
    loadAppointments,
    pendingAppointments,
    historyAppointments,
    cancelConfirmOpen,
    requestCancel,
    confirmCancel,
  };
}
