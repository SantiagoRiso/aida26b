import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import ClientsView from '@/views/staff/ClientsView.vue';
import { useAuthStore } from '@/stores/auth';
import { prefetchClientDetail } from '@/composables/clientDetailPrefetch';

vi.mock('@/composables/clientDetailPrefetch', () => ({
  prefetchClientDetail: vi.fn(),
}));
vi.mock('@/api/crud', () => ({
  listRows: vi.fn().mockResolvedValue({
    ok: true,
    data: [
      { id: '4', display_name: 'Bart Simpson', dni: '30440001', email: null, phone: null },
      { id: '9', display_name: 'Selma Bouvier', dni: null, email: null, phone: null },
    ],
  }),
}));
vi.mock('@/api/appointments', () => ({
  listRelatedClientIds: vi.fn().mockResolvedValue({ ok: true, data: [] }),
}));

const makeI18n = () => createI18n({ legacy: false, locale: 'es', messages: { es, en } });

// Admin sees every client, so the rows render without needing a prior-relationship fixture.
async function mountAsAdmin() {
  setActivePinia(createPinia());
  const auth = useAuthStore();
  auth.user = {
    id: 1, username: 'a', email: null, role: 'Admin', business_id: 5,
    is_active: true, must_change_password: false,
  };
  const wrapper = mount(ClientsView, {
    global: { plugins: [makeI18n()], stubs: { DetailPanel: true } },
  });
  await flushPromises();
  return wrapper;
}

describe('ClientsView warms the client detail cache on row hover', () => {
  beforeEach(() => {
    vi.mocked(prefetchClientDetail).mockClear();
  });

  it('prefetches the hovered row by numeric id', async () => {
    const wrapper = await mountAsAdmin();
    const rows = wrapper.findAll('tr.virtualized-row');
    expect(rows).toHaveLength(2);

    await rows[1]!.trigger('pointerenter');

    expect(prefetchClientDetail).toHaveBeenCalledWith(9);
  });

  it('prefetches on keyboard focus so the warm path is not pointer-only', async () => {
    const wrapper = await mountAsAdmin();
    const rows = wrapper.findAll('tr.virtualized-row');

    await rows[0]!.trigger('focusin');

    expect(prefetchClientDetail).toHaveBeenCalledWith(4);
  });
});
