import { ref, watch } from 'vue';
import type { Ref } from 'vue';
import { listRows } from '@/api/crud';
import { toMinutes } from '@shared/ssot/domain/availability';

// A professional's working block (weekday + minute range) with its own tiling step. slotMinutes is
// the block's service's effective duration, so the slot grid is the same in an empty month as a
// busy one — never derived from bookings.
export interface ProfessionalBlock {
  weekday: string;
  start: number;
  end: number;
  slotMinutes: number;
}

// The professional's working blocks fetched from the schedule directly (not availability), so
// booked slots are covered too.
export async function fetchProfessionalBlocks(
  professionalUserId: string | number,
): Promise<ProfessionalBlock[]> {
  const pid = String(professionalUserId);
  const [blocksRes, offersRes, servicesRes] = await Promise.all([
    listRows('schedule_blocks', { filters: { professional_user_id: pid }, limit: 500 }),
    listRows('schedule_block_services', { filters: { professional_user_id: pid }, limit: 500 }),
    listRows('services', { limit: 500 }),
  ]);
  if (!blocksRes.ok) return [];
  const serviceDefault = new Map<string, number>();
  if (servicesRes.ok) for (const s of servicesRes.data) serviceDefault.set(String(s.id), Number(s.default_duration_minutes));
  // A block tiles by its (first offered) service's effective duration: the per-block override, else the
  // service default. Blocks are single-service in practice; first-wins is stable across reads (by pk).
  const blockSlot = new Map<string, number>();
  if (offersRes.ok) for (const o of offersRes.data) {
    const key = String(o.schedule_block_id);
    if (blockSlot.has(key)) continue;
    const dur = o.duration_minutes != null ? Number(o.duration_minutes) : serviceDefault.get(String(o.service_id));
    if (dur && dur > 0) blockSlot.set(key, dur);
  }
  return blocksRes.data
    .filter((r) => r.resource_id == null)
    .map((r) => ({
      weekday: String(r.weekday),
      start: toMinutes(r.start_time.slice(0, 5)),
      end: toMinutes(r.end_time.slice(0, 5)),
      slotMinutes: blockSlot.get(String(r.id)) ?? 30,
    }));
}

// Reactive wrapper: reloads whenever the source professional changes; null clears (mixed view).
export function useProfessionalBlocks(
  source: () => string | number | null | undefined,
): { blocks: Ref<ProfessionalBlock[]> } {
  const blocks = ref<ProfessionalBlock[]>([]);
  watch(source, async (id) => {
    blocks.value = id == null ? [] : await fetchProfessionalBlocks(id);
  }, { immediate: true });
  return { blocks };
}
