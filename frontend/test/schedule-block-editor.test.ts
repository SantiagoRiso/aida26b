import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { useUiStore } from '@/stores/ui';
import { listRows, createRow, updateRow, deleteRow } from '@/api/crud';
import ScheduleBlockEditor from '@/components/schedule/ScheduleBlockEditor.vue';
import type { OwnerKind } from '@shared/ssot/domain/conflict';

vi.mock('@/api/crud', () => ({
  listRows: vi.fn(),
  createRow: vi.fn(),
  updateRow: vi.fn(),
  deleteRow: vi.fn(),
}));

const existingBlock = {
  id: '1', professional_user_id: '1', resource_id: null, weekday: 'mon', start_time: '09:00', end_time: '12:00',
};

const makeI18n = () => createI18n({ legacy: false, locale: 'es', messages: { es, en } });

// The editor modal and confirm dialog are HeadlessUI Dialogs (Teleport + focus management); these
// tests drive the component's exposed handlers directly, so stub the dialogs' DOM out.
function mountEditor(owner: { kind: OwnerKind; id: number } = { kind: 'professional', id: 1 }) {
  return mount(ScheduleBlockEditor, {
    props: { owner },
    global: { plugins: [makeI18n()], stubs: { BlockEditorModal: true, ConfirmDialog: true } },
  });
}

// FullCalendar isn't rendered under jsdom in these tests — instead, the `select` handler wired
// into calendarOptions (exposed via defineExpose) is invoked directly with a synthetic arg shaped
// like FullCalendar's real DateSelectArg (only the fields onSelect actually reads).
function fakeSelectArg(startStr: string, endStr: string) {
  return { startStr, endStr, view: { calendar: { unselect: vi.fn() } } };
}

describe('ScheduleBlockEditor', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(listRows).mockImplementation(async (table: string) => {
      if (table === 'schedule_blocks') {
        return { ok: true, data: [existingBlock] };
      }
      return { ok: true, data: [] };
    });
  });

  it('rejects an overlapping selection without calling createRow', async () => {
    const wrapper = mountEditor();
    await flushPromises();

    // Overlaps the existing Mon 09:00-12:00 block.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (wrapper.vm as any).calendarOptions.select(fakeSelectArg('2024-01-01T11:00:00', '2024-01-01T13:00:00'));
    await flushPromises();

    expect(createRow).not.toHaveBeenCalled();
    const ui = useUiStore();
    expect(ui.toasts.at(-1)).toMatchObject({ kind: 'error', messageKey: 'scheduleBlockOverlap' });
  });

  it('creates a block for a non-overlapping selection with the right body', async () => {
    vi.mocked(createRow).mockResolvedValueOnce({
      ok: true,
      data: { id: '99', professional_user_id: '1', resource_id: null, weekday: 'mon', start_time: '13:00', end_time: '14:00' },
    });
    const wrapper = mountEditor();
    await flushPromises();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (wrapper.vm as any).calendarOptions.select(fakeSelectArg('2024-01-01T13:00:00', '2024-01-01T14:00:00'));
    await flushPromises();

    expect(createRow).toHaveBeenCalledWith('schedule_blocks', {
      professional_user_id: '1',
      resource_id: null,
      weekday: 'mon',
      start_time: '13:00',
      end_time: '14:00',
    });
  });

  it('rejects a start>=end selection without calling createRow', async () => {
    const wrapper = mountEditor();
    await flushPromises();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (wrapper.vm as any).calendarOptions.select(fakeSelectArg('2024-01-03T10:00:00', '2024-01-03T10:00:00'));
    await flushPromises();

    expect(createRow).not.toHaveBeenCalled();
    const ui = useUiStore();
    expect(ui.toasts.at(-1)).toMatchObject({ kind: 'error', messageKey: 'scheduleBlockInvalidRange' });
  });

  it('moves a block via decideUpdate wiring and calls updateRow with the right body', async () => {
    vi.mocked(updateRow).mockResolvedValueOnce({
      ok: true,
      data: { id: '1', professional_user_id: '1', resource_id: null, weekday: 'mon', start_time: '10:00', end_time: '13:00' },
    });
    const wrapper = mountEditor();
    await flushPromises();
    const revert = vi.fn();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (wrapper.vm as any).calendarOptions.eventDrop({
      event: { id: '1', startStr: '2024-01-01T10:00:00', endStr: '2024-01-01T13:00:00' },
      revert,
    });
    await flushPromises();

    expect(updateRow).toHaveBeenCalledWith('schedule_blocks', '1', {
      professional_user_id: '1',
      resource_id: null,
      weekday: 'mon',
      start_time: '10:00',
      end_time: '13:00',
    });
    expect(revert).not.toHaveBeenCalled();
  });

  it('reverts a move that would overlap another block and does not call updateRow', async () => {
    vi.mocked(listRows).mockImplementation(async (table: string) => {
      if (table === 'schedule_blocks') {
        return { ok: true, data: [
          existingBlock,
          { id: '2', professional_user_id: '1', resource_id: null, weekday: 'mon', start_time: '14:00', end_time: '16:00' },
        ] };
      }
      return { ok: true, data: [] };
    });
    const wrapper = mountEditor();
    await flushPromises();
    const revert = vi.fn();

    // Block '2' dragged onto block '1''s Mon 09:00-12:00 span.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (wrapper.vm as any).calendarOptions.eventDrop({
      event: { id: '2', startStr: '2024-01-01T10:00:00', endStr: '2024-01-01T12:00:00' },
      revert,
    });
    await flushPromises();

    expect(updateRow).not.toHaveBeenCalled();
    expect(revert).toHaveBeenCalled();
    const ui = useUiStore();
    expect(ui.toasts.at(-1)).toMatchObject({ kind: 'error', messageKey: 'scheduleBlockOverlap' });
  });

  it('deletes the selected block on confirm', async () => {
    vi.mocked(deleteRow).mockResolvedValueOnce({ ok: true, data: existingBlock });
    const wrapper = mountEditor();
    await flushPromises();

    // Clicking a block selects it and opens the editor modal.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (wrapper.vm as any).calendarOptions.eventClick({ event: { id: '1' } });
    await flushPromises();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((wrapper.vm as any).editorOpen).toBe(true);

    // Delete is confirmed outside the editor; drive the confirm handler directly rather than the
    // ConfirmDialog's own Teleport/transition DOM.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (wrapper.vm as any).onDeleteConfirm();
    await flushPromises();

    expect(deleteRow).toHaveBeenCalledWith('schedule_blocks', '1');
  });

  it('persists block times via updateRow and reports success (modal orchestrates the close)', async () => {
    vi.mocked(updateRow).mockResolvedValueOnce({
      ok: true,
      data: { id: '1', professional_user_id: '1', resource_id: null, weekday: 'mon', start_time: '09:05', end_time: '11:35' },
    });
    const wrapper = mountEditor();
    await flushPromises();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (wrapper.vm as any).calendarOptions.eventClick({ event: { id: '1' } });
    await flushPromises();

    // Per-minute textbox edit (09:05-11:35) within block '1''s own span → no overlap with itself.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ok = await (wrapper.vm as any).saveTimes({ startTime: '09:05', endTime: '11:35' });
    await flushPromises();

    expect(ok).toBe(true);
    expect(updateRow).toHaveBeenCalledWith('schedule_blocks', '1', {
      professional_user_id: '1',
      resource_id: null,
      weekday: 'mon',
      start_time: '09:05',
      end_time: '11:35',
    });
  });

  it('rejects a modal time edit that overlaps another block without calling updateRow', async () => {
    vi.mocked(listRows).mockImplementation(async (table: string) => {
      if (table === 'schedule_blocks') {
        return { ok: true, data: [
          existingBlock, // Mon 09:00-12:00
          { id: '2', professional_user_id: '1', resource_id: null, weekday: 'mon', start_time: '14:00', end_time: '16:00' },
        ] };
      }
      return { ok: true, data: [] };
    });
    const wrapper = mountEditor();
    await flushPromises();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (wrapper.vm as any).calendarOptions.eventClick({ event: { id: '2' } });
    await flushPromises();

    // Edit block '2' to 11:00-15:00 → overlaps block '1' (Mon 09:00-12:00).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ok = await (wrapper.vm as any).saveTimes({ startTime: '11:00', endTime: '15:00' });
    await flushPromises();

    expect(ok).toBe(false);
    expect(updateRow).not.toHaveBeenCalled();
    const ui = useUiStore();
    expect(ui.toasts.at(-1)).toMatchObject({ kind: 'error', messageKey: 'scheduleBlockOverlap' });
  });

  it('creates a resource-owned block with the resource FK set and professional FK null', async () => {
    vi.mocked(listRows).mockImplementation(async (table: string) => {
      if (table === 'schedule_blocks') {
        return { ok: true, data: [
          { id: '1', professional_user_id: null, resource_id: '7', weekday: 'mon', start_time: '09:00', end_time: '12:00' },
        ] };
      }
      return { ok: true, data: [] };
    });
    vi.mocked(createRow).mockResolvedValueOnce({
      ok: true,
      data: { id: '99', professional_user_id: null, resource_id: '7', weekday: 'mon', start_time: '13:00', end_time: '14:00' },
    });
    const wrapper = mountEditor({ kind: 'resource', id: 7 });
    await flushPromises();

    // Non-overlapping with the existing Mon 09:00-12:00 resource block.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (wrapper.vm as any).calendarOptions.select(fakeSelectArg('2024-01-01T13:00:00', '2024-01-01T14:00:00'));
    await flushPromises();

    expect(createRow).toHaveBeenCalledWith('schedule_blocks', {
      professional_user_id: null,
      resource_id: '7',
      weekday: 'mon',
      start_time: '13:00',
      end_time: '14:00',
    });
  });
});
