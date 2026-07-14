import { ref, computed, watch, type Ref } from 'vue';
import { getBookingWindow } from '@/api/scheduling';
import { todayLocalISO } from '@/composables/useCurrency';

// The effective booking window (concrete dates) for a professional + service, shared by both
// agendar-turno forms so they clamp their date picker the same way. Re-fetches when either id
// changes and drops a stale response if the selection moved on while awaiting.
export function useBookingWindow(professionalId: Ref<number | null>, serviceId: Ref<number | null>) {
  const windowMin = ref<string | null>(null);
  const windowMax = ref<string | null>(null);
  const today = todayLocalISO();

  watch(
    [professionalId, serviceId],
    async ([profId, svcId]) => {
      windowMin.value = null;
      windowMax.value = null;
      if (profId == null || svcId == null) return;
      const res = await getBookingWindow(profId, svcId);
      if (professionalId.value !== profId || serviceId.value !== svcId) return;
      if (res.ok) {
        windowMin.value = res.data.min_date;
        windowMax.value = res.data.max_date;
      }
    },
    { immediate: true },
  );

  // Effective lower bound: the window's minimum when it's beyond today, otherwise today.
  const minDate = computed(() => (windowMin.value && windowMin.value > today ? windowMin.value : today));

  return { windowMin, windowMax, minDate };
}
