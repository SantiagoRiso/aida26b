import { ref, computed } from 'vue';
import { listAppointments } from '@/api/appointments';
import type { Appointment } from '@/api/appointments';
import { isVirtualOccurrence } from '@/composables/seriesOccurrence';
import { useAuthStore } from '@/stores/auth';
import { businessDate } from '@shared/ssot/domain/availability';

export function useProfessionalDashboard() {
  const auth = useAuthStore();
  const userId = computed(() => auth.user?.id);

  const proUpcoming = ref<Appointment[]>([]);
  const proPending = ref<Appointment[]>([]);
  const loadingPro = ref(false);
  // A failed load must not read as an empty agenda.
  const proLoadFailed = ref(false);

  async function loadProfessional() {
    loadingPro.value = true;
    proLoadFailed.value = false;
    try {
      const [upcomingRes, pendingRes] = await Promise.all([
        listAppointments({
          professional_user_id: userId.value,
          date_from: businessDate(),
          limit: 5,
        }),
        listAppointments({
          professional_user_id: userId.value,
          state: 'requested',
          limit: 5,
        }),
      ]);
      // Dashboard summary widgets, read-only — a virtual (un-materialized) occurrence is filtered
      // out rather than shown as an inert card.
      if (upcomingRes.ok) {
        proUpcoming.value = upcomingRes.data.filter((a): a is Appointment => !isVirtualOccurrence(a)).slice(0, 5);
      }
      if (pendingRes.ok) proPending.value = pendingRes.data.filter((a): a is Appointment => !isVirtualOccurrence(a));
      if (!upcomingRes.ok || !pendingRes.ok) proLoadFailed.value = true;
    } finally {
      loadingPro.value = false;
    }
  }

  return { proUpcoming, proPending, loadingPro, proLoadFailed, loadProfessional };
}
