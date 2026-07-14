import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { listRows, createRow, updateRow, deleteRow } from '@/api/crud';
import ResourcesSection from '@/components/settings/ResourcesSection.vue';
import ConfirmDialog from '@/components/shared/ConfirmDialog.vue';

vi.mock('@/api/crud', () => ({
  listRows: vi.fn(),
  createRow: vi.fn(),
  updateRow: vi.fn(),
  deleteRow: vi.fn(),
}));

const makeI18n = () => createI18n({ legacy: false, locale: 'es', messages: { es, en } });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockRooms(data: any[]) {
  vi.mocked(listRows).mockResolvedValue({ ok: true, data } as never);
}

// Stub the heavy schedule editor so it doesn't hit the network; render its owner so we can assert on it.
const ScheduleBlockEditorStub = {
  name: 'ScheduleBlockEditor',
  props: ['owner'],
  template: '<div class="sbe-stub">{{ owner.kind }}:{{ owner.id }}</div>',
};

function mountSection() {
  return mount(ResourcesSection, {
    global: {
      plugins: [makeI18n()],
      stubs: { ScheduleBlockEditor: ScheduleBlockEditorStub, teleport: true },
    },
  });
}

describe('ResourcesSection', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('lists rooms', async () => {
    mockRooms([
      { id: '1', business_id: 'b1', name: 'Sala A', description: null },
      { id: '2', business_id: 'b1', name: 'Sala B', description: 'Piso 2' },
    ]);
    const w = mountSection();
    await flushPromises();
    expect(listRows).toHaveBeenCalledWith('resources', { limit: 200 });
    expect(w.text()).toContain('Sala A');
    expect(w.text()).toContain('Sala B');
  });

  it('adds a room from an inline name', async () => {
    mockRooms([]);
    vi.mocked(createRow).mockResolvedValue({ ok: true, data: { id: '9', business_id: 'b1', name: 'Nueva', description: null } } as never);
    const w = mountSection();
    await flushPromises();
    await w.get('[data-testid="room-add-start"]').trigger('click');
    await w.get('[data-testid="room-add-name"]').setValue('Nueva');
    await w.get('[data-testid="room-add-save"]').trigger('click');
    await flushPromises();
    expect(createRow).toHaveBeenCalledWith('resources', { name: 'Nueva' });
  });

  it('blocks add when the name is empty', async () => {
    mockRooms([]);
    const w = mountSection();
    await flushPromises();
    await w.get('[data-testid="room-add-start"]').trigger('click');
    await w.get('[data-testid="room-add-save"]').trigger('click');
    await flushPromises();
    expect(createRow).not.toHaveBeenCalled();
  });

  it('edits a room name and description', async () => {
    mockRooms([{ id: '1', business_id: 'b1', name: 'Sala A', description: null }]);
    vi.mocked(updateRow).mockResolvedValue({ ok: true, data: { id: '1', business_id: 'b1', name: 'Sala A1', description: 'Piso 2' } } as never);
    const w = mountSection();
    await flushPromises();
    await w.get('[data-testid="room-edit-1"]').trigger('click');
    await w.get('[data-testid="room-edit-name-1"]').setValue('Sala A1');
    await w.get('[data-testid="room-edit-description-1"]').setValue('Piso 2');
    await w.get('[data-testid="room-edit-save-1"]').trigger('click');
    await flushPromises();
    expect(updateRow).toHaveBeenCalledWith('resources', '1', { name: 'Sala A1', description: 'Piso 2' });
  });

  it('opens the schedule editor for the room owner', async () => {
    mockRooms([{ id: '1', business_id: 'b1', name: 'Sala A', description: null }]);
    // DetailPanel's Dialog teleports its content to document.body, and headlessui-vue's
    // TransitionChild breaks entirely when the global `teleport` stub is active (renders nothing) —
    // so this one assertion mounts with a real DOM attachment and reads the teleported portal
    // content directly instead of going through mountSection()/w.text().
    const w = mount(ResourcesSection, {
      attachTo: document.body,
      global: {
        plugins: [makeI18n()],
        stubs: { ScheduleBlockEditor: ScheduleBlockEditorStub },
      },
    });
    await flushPromises();
    await w.get('[data-testid="room-schedule-1"]').trigger('click');
    await flushPromises();
    expect(document.body.textContent).toContain('resource:1');
    w.unmount();
  });

  it('deletes a room through the confirm dialog', async () => {
    mockRooms([{ id: '1', business_id: 'b1', name: 'Sala A', description: null }]);
    vi.mocked(deleteRow).mockResolvedValue({ ok: true, data: { id: '1' } } as never);
    const w = mountSection();
    await flushPromises();
    await w.get('[data-testid="room-delete-1"]').trigger('click');
    await w.findComponent(ConfirmDialog).vm.$emit('confirm');
    await flushPromises();
    expect(deleteRow).toHaveBeenCalledWith('resources', '1');
  });
});
