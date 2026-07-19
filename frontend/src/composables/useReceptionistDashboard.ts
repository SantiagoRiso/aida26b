import { ref } from 'vue';
import { listAppointments } from '@/api/appointments';
import type { Appointment } from '@/api/appointments';
import { isVirtualOccurrence } from '@/composables/seriesOccurrence';

export function useReceptionistDashboard() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  const recToday = ref<Appointment[]>([]);
  const recPending = ref<Appointment[]>([]);
  const loadingRec = ref(false);

  async function loadReceptionist() {
    loadingRec.value = true;
    const [todayRes, pendingRes] = await Promise.all([
      listAppointments({
        date_from: todayStart.toISOString().slice(0, 10),
        date_to: todayEnd.toISOString().slice(0, 10),
        limit: 50,
      }),
      listAppointments({ state: 'requested', limit: 5 }),
    ]);
    // Dashboard summary widgets, read-only — a virtual (un-materialized) occurrence is filtered
    // out rather than shown as an inert card.
    if (todayRes.ok) recToday.value = todayRes.data.filter((a): a is Appointment => !isVirtualOccurrence(a));
    if (pendingRes.ok) recPending.value = pendingRes.data.filter((a): a is Appointment => !isVirtualOccurrence(a));
    loadingRec.value = false;
  }

  return { recToday, recPending, loadingRec, loadReceptionist };
}
