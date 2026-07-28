<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DateSelectArg, EventClickArg, EventDropArg } from '@fullcalendar/core';
import type { EventResizeDoneArg } from '@fullcalendar/interaction';
import CalendarView from '@/components/calendar/CalendarView.vue';
import BlockEditorModal from '@/components/schedule/BlockEditorModal.vue';
import ConfirmDialog from '@/components/shared/ConfirmDialog.vue';
import AppButton from '@/components/shared/AppButton.vue';
import { listRows, createRow, updateRow, deleteRow } from '@/api/crud';
import { useToast } from '@/composables/useToast';
import { useScheduleTemplate } from '@/composables/useScheduleTemplate';
import { useTimegridGeometry } from '@/composables/useTimegridGeometry';
import { useTemplateBlockDrag } from '@/composables/useTemplateBlockDrag';
import { decideCreate, decideUpdate, weekdayToDate, dateToWeekday, type TemplateBlock, type WeekdayTimes, type DecideResult } from '@/composables/scheduleTemplateGrid';
import type { TableRecordMap } from '@shared/ssot/derived';
import type { OwnerKind } from '@shared/ssot/domain/conflict';
import { isWeekday } from '@shared/ssot/domain/availability';
import type { Weekday } from '@shared/ssot/domain/availability';

const props = defineProps<{ owner: { kind: OwnerKind; id: number } }>();

const { t } = useI18n();
const toast = useToast();

const blocks = ref<TemplateBlock[]>([]);
// The parent only mounts this component once an owner is chosen, and the server enforces
// per-owner authorization (professional self-scope or Admin's grant on a resource).
const editable = computed(() => true);

const selectedBlockId = ref<string | null>(null);
const editorOpen = ref(false);
const confirmDeleteOpen = ref(false);
// The services panel targets the same clicked block that's armed for delete — derived so there's
// one selection state, not two that can drift (e.g. a move/resize updating stale panel data).
const selectedBlock = computed(() => blocks.value.find((b) => b.id === selectedBlockId.value) ?? null);

function toTemplateBlock(r: TableRecordMap['schedule_blocks']): TemplateBlock | null {
  if (!isWeekday(r.weekday)) return null;
  return {
    id: String(r.id),
    professional_user_id: String(r.professional_user_id ?? ''),
    weekday: r.weekday,
    // The API serialises TIME as 'HH:MM:SS'; TemplateBlock is 'HH:MM' — normalise at the boundary.
    start_time: r.start_time.slice(0, 5),
    end_time: r.end_time.slice(0, 5),
  };
}

async function loadBlocks() {
  blocks.value = [];
  selectedBlockId.value = null;
  const { kind, id } = props.owner;
  const filterKey = kind === 'professional' ? 'professional_user_id' : 'resource_id';
  const res = await listRows('schedule_blocks', { filters: { [filterKey]: String(id) }, limit: 500 });
  if (res.ok) {
    blocks.value = res.data
      .filter((r) => (kind === 'professional' ? r.resource_id == null : r.professional_user_id == null))
      .flatMap((row) => {
        const block = toTemplateBlock(row);
        return block ? [block] : [];
      });
  }
}
// Keyed by value, not by the prop object. Both mount sites pass an object literal, so every parent
// re-render produced a fresh identity: watching the reference reloaded the list and cleared the
// selection mid-interaction, and a click on a block then opened the editor with nothing selected,
// which reads as creating a new one.
watch(() => `${props.owner.kind}:${props.owner.id}`, loadBlocks);
onMounted(loadBlocks);

// A row we just wrote should always map back; one that doesn't carries a weekday this editor can't
// place, so resync from the server rather than leaving an unrenderable hole in the local list.
async function absorbWrittenBlock(
  row: TableRecordMap['schedule_blocks'],
  place: (block: TemplateBlock) => TemplateBlock[],
): Promise<void> {
  const block = toTemplateBlock(row);
  if (block == null) {
    await loadBlocks();
    return;
  }
  blocks.value = place(block);
}

// A block belongs to exactly one owner — the non-owning FK is explicitly nulled.
function writeBody(times: WeekdayTimes): Partial<TableRecordMap['schedule_blocks']> {
  const { kind, id } = props.owner;
  return {
    professional_user_id: kind === 'professional' ? String(id) : null,
    resource_id: kind === 'resource' ? String(id) : null,
    weekday: times.weekday,
    start_time: times.start_time,
    end_time: times.end_time,
  };
}

// One place turns a rejected placement into words. An overlap names the window it hit, because
// "se superpone con otro" leaves the user hunting for which one on a week with several blocks.
function reportRejection(decision: Extract<DecideResult, { ok: false }>) {
  if (decision.reason === 'overlap') {
    const { start_time, end_time } = decision.conflict;
    toast.error('scheduleBlockOverlap', { start: start_time, end: end_time });
    return;
  }
  toast.error(decision.reason === 'crossesDay' ? 'scheduleBlockCrossesDay' : 'scheduleBlockEndAfterStart');
}

async function onSelect(arg: DateSelectArg) {
  const cal = arg.view.calendar;
  cal.unselect();

  const decision = decideCreate({ startStr: arg.startStr, endStr: arg.endStr }, blocks.value);
  if (!decision.ok) {
    reportRejection(decision);
    return;
  }

  const res = await createRow('schedule_blocks', writeBody(decision.body));
  if (res.ok) {
    await absorbWrittenBlock(res.data, (block) => [...blocks.value, block]);
  } else {
    toast.error('scheduleBlockSaveError');
  }
}

// A completed custom drag emits a trailing click; swallow it once so it doesn't also open the editor.
// Cleared at the next block press so it can never suppress an unrelated later click.
let suppressClick = false;
function onEventClick(arg: EventClickArg) {
  if (suppressClick) { suppressClick = false; return; }
  selectedBlockId.value = arg.event.id;
  editorOpen.value = true;
}

// No selected block means the modal is creating one — the keyboard path to both adding a block and
// putting it on another weekday, neither of which a drag-only grid can offer.
function openCreateBlock() {
  selectedBlockId.value = null;
  editorOpen.value = true;
}

// Persist the block window edited via the modal's fields — same overlap/validity rule as a drag.
// Returns success; the modal orchestrates the full submit (times + services) and closes on both.
// Times typed into the form persist exactly as entered; only a drag snaps to neighbouring edges.
async function submitBlock(times: { weekday: Weekday; startTime: string; endTime: string }): Promise<boolean> {
  const block = selectedBlock.value;
  const date = weekdayToDate(times.weekday);
  const decision = decideUpdate(
    { startStr: `${date}T${times.startTime}:00`, endStr: `${date}T${times.endTime}:00` },
    blocks.value,
    block?.id ?? '',
  );
  if (!decision.ok) {
    reportRejection(decision);
    return false;
  }
  const res = block
    ? await updateRow('schedule_blocks', block.id, writeBody(decision.body))
    : await createRow('schedule_blocks', writeBody(decision.body));
  if (res.ok) {
    await absorbWrittenBlock(res.data, (written) => (block
      ? blocks.value.map((b) => (b.id === block.id ? written : b))
      : [...blocks.value, written]));
    return true;
  }
  toast.error('scheduleBlockSaveError');
  return false;
}

// Delete is confirmed outside the editor to avoid stacked dialogs: close the editor, open confirm.
function onDeleteRequest() {
  editorOpen.value = false;
  confirmDeleteOpen.value = true;
}

async function applyMove(id: string, startStr: string, endStr: string, revert: () => void) {
  const decision = decideUpdate({ startStr, endStr }, blocks.value, id);
  if (!decision.ok) {
    reportRejection(decision);
    revert();
    return;
  }

  const res = await updateRow('schedule_blocks', id, writeBody(decision.body));
  if (res.ok) {
    await absorbWrittenBlock(res.data, (updated) =>
      blocks.value.map((b) => (b.id === id ? updated : b)));
  } else {
    toast.error('scheduleBlockSaveError');
    revert();
  }
}

function onEventDrop(arg: EventDropArg) {
  void applyMove(arg.event.id, arg.event.startStr, arg.event.endStr, arg.revert);
}

function onEventResize(arg: EventResizeDoneArg) {
  void applyMove(arg.event.id, arg.event.startStr, arg.event.endStr, arg.revert);
}

async function onDeleteConfirm() {
  confirmDeleteOpen.value = false;
  const id = selectedBlockId.value;
  if (id == null) return;
  const res = await deleteRow('schedule_blocks', id);
  if (res.ok) {
    blocks.value = blocks.value.filter((b) => b.id !== id);
    selectedBlockId.value = null;
  } else {
    toast.error('scheduleBlockDeleteError');
  }
}

const { calendarOptions, narrowViewport } = useScheduleTemplate(blocks, {
  onSelect, onEventClick, onEventDrop, onEventResize, editable,
});

// Custom mid-drag move/resize: a live ghost that snaps flush to neighbouring blocks and clamps inside
// their free time (overlap is impossible). Reuses applyMove for the same overlap-checked persistence
// the native drag used. FC-native event editing is disabled in useScheduleTemplate.
const sectionRef = ref<HTMLElement | null>(null);
const calendarRef = ref<InstanceType<typeof CalendarView> | null>(null);
const geometry = useTimegridGeometry(() => calendarRef.value?.getRootEl() ?? null);

// initialView only decides the first render, so crossing the breakpoint has to move the live grid.
watch(narrowViewport, (narrow) => {
  calendarRef.value?.getApi()?.changeView(narrow ? 'timeGridDay' : 'timeGridWeek');
});
const dragging = ref(false);
const blockDrag = useTemplateBlockDrag({
  geometry,
  weekdayForDate: dateToWeekday,
  allBlocks: () => blocks.value,
  ghostParent: () => calendarRef.value?.getRootEl() ?? null,
  onBegin: () => { dragging.value = true; },
  onEnd: () => { dragging.value = false; suppressClick = true; },
  onCommit: (id, times) => {
    const date = weekdayToDate(times.weekday);
    void applyMove(id, `${date}T${times.start_time}:00`, `${date}T${times.end_time}:00`, () => {});
  },
});

const RESIZE_EDGE_PX = 8;
function blockUnder(ev: PointerEvent): HTMLElement | null {
  if (!(ev.target instanceof Element)) return null;
  const event = ev.target.closest('.fc-timegrid-event');
  return event instanceof HTMLElement ? event : null;
}

function onBlockPointerDown(ev: PointerEvent) {
  suppressClick = false;
  if (!editable.value) return;
  const el = blockUnder(ev);
  const id = el?.dataset.blockId;
  if (!el || !id) return;
  const block = blocks.value.find((b) => b.id === id);
  if (block) blockDrag.start(block, ev, el);
}

// Cursor affordance: the top/bottom edge resizes (ns-resize), the body moves (grab). Driven from JS
// because the resize zones are geometric, not separate elements. Suppressed while a drag is running.
function onBlockHover(ev: PointerEvent) {
  if (dragging.value || !editable.value) return;
  const el = blockUnder(ev);
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const edge = Math.min(RESIZE_EDGE_PX, rect.height / 3);
  el.style.cursor = ev.clientY <= rect.top + edge || ev.clientY >= rect.bottom - edge ? 'ns-resize' : 'grab';
}

onMounted(() => {
  sectionRef.value?.addEventListener('pointerdown', onBlockPointerDown);
  sectionRef.value?.addEventListener('pointermove', onBlockHover);
});
onBeforeUnmount(() => {
  sectionRef.value?.removeEventListener('pointerdown', onBlockPointerDown);
  sectionRef.value?.removeEventListener('pointermove', onBlockHover);
});

// Exposed so tests can drive the exact handlers FullCalendar and the editor modal would call,
// without mounting FC or the dialog's Teleport DOM (delete-confirm and textbox-save flows).
defineExpose({ calendarOptions, onDeleteConfirm, submitBlock, openCreateBlock, editorOpen });
</script>

<template>
  <section ref="sectionRef" class="flex flex-col gap-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <p class="text-xs text-neutral">{{ t('schedule.addHint') }}</p>
      <AppButton size="sm" data-testid="schedule-add-block" @click="openCreateBlock">
        {{ t('schedule.addBlock') }}
      </AppButton>
    </div>
    <div class="schedule-grid rounded-lg border border-border bg-card p-3 shadow-sm">
      <CalendarView ref="calendarRef" :options="calendarOptions" />
    </div>

    <BlockEditorModal
      :open="editorOpen"
      :block="selectedBlock"
      :submit="submitBlock"
      :show-services="props.owner.kind === 'professional'"
      @delete="onDeleteRequest"
      @close="editorOpen = false"
    />

    <ConfirmDialog
      :open="confirmDeleteOpen"
      :title="t('schedule.deleteBlock')"
      :body="t('schedule.deleteConfirm')"
      :confirm-label="t('actions.confirm')"
      destructive
      @confirm="onDeleteConfirm"
      @cancel="confirmDeleteOpen = false"
    />
  </section>
</template>

<style scoped>
/* Blocks carry no per-event colour, so they take the app-wide FullCalendar event tokens mapped in
   main.css — solid accent bands that invite a click, and that follow the theme. */
.schedule-grid :deep(.fc-timegrid-event) {
  border-radius: 6px;
  box-shadow: none;
  /* Move/resize is pointer-driven (useTemplateBlockDrag): a finger drag must not double as a scroll,
     which would cancel the pointer stream mid-gesture. */
  touch-action: none;
}
.schedule-grid :deep(.fc-event-main) {
  padding: 2px 6px;
  font-weight: 600;
}
</style>
