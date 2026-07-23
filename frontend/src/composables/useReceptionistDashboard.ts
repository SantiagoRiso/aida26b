import { ref } from 'vue';
import { listAppointments } from '@/api/appointments';
import type { Appointment } from '@/api/appointments';
import { isVirtualOccurrence } from '@/composables/seriesOccurrence';
import { businessDate } from '@shared/ssot/domain/availability';

export function useReceptionistDashboard() {
  const recToday = ref<Appointment[]>([]);
  const recPending = ref<Appointment[]>([]);
  const loadingRec = ref(false);
  // A failed load must not read as an empty day.
  const recLoadFailed = ref(false);

  async function loadReceptionist() {
    loadingRec.value = true;
    recLoadFailed.value = false;
    try {
      // Both bounds are the same business day; the server resolves a bare date to that whole day.
      const today = businessDate();
      const [todayRes, pendingRes] = await Promise.all([
        listAppointments({
          date_from: today,
          date_to: today,
          limit: 50,
        }),
        listAppointments({ state: 'requested', limit: 5 }),
      ]);
      // Dashboard summary widgets, read-only — a virtual (un-materialized) occurrence is filtered
      // out rather than shown as an inert card.
      if (todayRes.ok) recToday.value = todayRes.data.filter((a): a is Appointment => !isVirtualOccurrence(a));
      if (pendingRes.ok) recPending.value = pendingRes.data.filter((a): a is Appointment => !isVirtualOccurrence(a));
      if (!todayRes.ok || !pendingRes.ok) recLoadFailed.value = true;
    } finally {
      loadingRec.value = false;
    }
  }

  return { recToday, recPending, loadingRec, recLoadFailed, loadReceptionist };
}
