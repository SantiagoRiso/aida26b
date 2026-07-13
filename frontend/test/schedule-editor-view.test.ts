import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { listRows } from '@/api/crud';
import ScheduleEditorView from '@/views/staff/ScheduleEditorView.vue';

vi.mock('@/api/crud', () => ({
  listRows: vi.fn(),
  createRow: vi.fn(),
  updateRow: vi.fn(),
  deleteRow: vi.fn(),
}));

const makeI18n = () => createI18n({ legacy: false, locale: 'es', messages: { es, en } });

// The child editor owns all block CRUD; the wrapper only picks a professional, so stub it out.
const mountOpts = () => ({ global: { plugins: [makeI18n()], stubs: { ScheduleBlockEditor: true } } });

describe('ScheduleEditorView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(listRows).mockImplementation(async (table: string) => {
      if (table === 'professionals') {
        return { ok: true, data: [
          { id: '1', display_name: 'Dr. Ana' },
          { id: '2', display_name: 'Dr. Bruno' },
        ] };
      }
      return { ok: true, data: [] };
    });
  });

  it('shows the empty hint until a professional is picked', async () => {
    const wrapper = mount(ScheduleEditorView, mountOpts());
    await flushPromises();
    expect(wrapper.text()).toContain('Seleccionar un profesional');
    const select = wrapper.get('select');
    expect(select.findAll('option').length).toBe(3); // placeholder + 2 professionals
  });
});
