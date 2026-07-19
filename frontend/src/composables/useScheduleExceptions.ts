import { computed, ref, watch, type Ref } from 'vue';
import type { EventInput } from '@fullcalendar/core';
import { listRows } from '@/api/crud';
import { exceptionToBgEvent, filterByRange, type ExceptionRow } from './scheduleExceptions';

export function useScheduleExceptions(
  ownerFilter: Ref<{ professional_user_id: number | null; resource_id: number | null }>,
  range: Ref<{ from: string; to: string }>,
): { rows: Ref<ExceptionRow[]>; bgEvents: Ref<EventInput[]>; reload: () => Promise<void> } {
  const all = ref<ExceptionRow[]>([]);
  async function reload() {
    const f = ownerFilter.value;
    if (f.professional_user_id == null && f.resource_id == null) { all.value = []; return; }
    const filters: Record<string, string> = f.professional_user_id != null
      ? { professional_user_id: String(f.professional_user_id) }
      : { resource_id: String(f.resource_id) };
    const res = await listRows('schedule_exceptions', { filters, limit: 500 });
    all.value = res.ok ? res.data : [];
  }
  const rows = computed(() => filterByRange(all.value, range.value.from, range.value.to));
  const bgEvents = computed<EventInput[]>(() => rows.value.map(exceptionToBgEvent));
  watch([ownerFilter, range], reload, { deep: true, immediate: true });
  return { rows, bgEvents, reload };
}
