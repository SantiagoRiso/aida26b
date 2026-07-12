import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import CrudSection from '@/components/generic/CrudSection.vue';
import GenericTable from '@/components/generic/GenericTable.vue';
import DetailPanel from '@/components/shared/DetailPanel.vue';

// The table and form fetch rows / FK options via the CRUD API; stub so mounting stays offline.
vi.mock('@/api/crud', () => ({
  listRows: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  deleteRow: vi.fn().mockResolvedValue({ ok: true }),
  createRow: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  updateRow: vi.fn().mockResolvedValue({ ok: true, data: {} }),
}));

function makeI18n() {
  return createI18n({ legacy: false, locale: 'es', messages: { es, en } });
}

function mountSection() {
  return mount(CrudSection, {
    props: {
      tableKey: 'services',
      panelTitle: { es: 'Servicio', en: 'Service' },
      deleteLabel: { es: 'Eliminar', en: 'Delete' },
      deleteBody: { es: '¿Confirmás?', en: 'Confirm?' },
    },
    global: { plugins: [makeI18n()] },
  });
}

describe('CrudSection', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('opens the create panel when the table emits create', async () => {
    const wrapper = mountSection();
    await flushPromises();

    expect(wrapper.findComponent(DetailPanel).props('open')).toBe(false);
    wrapper.findComponent(GenericTable).vm.$emit('create');
    await flushPromises();
    expect(wrapper.findComponent(DetailPanel).props('open')).toBe(true);
  });
});
