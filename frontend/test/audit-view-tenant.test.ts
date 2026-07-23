import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { useAuthStore } from '@/stores/auth';
import { LIST_DEFAULT_LIMIT } from '@shared/ssot/list-protocol';

vi.mock('@/api/audit', () => ({ listAudit: vi.fn() }));

import AuditView from '@/views/staff/AuditView.vue';
import { listAudit } from '@/api/audit';

const listAuditMock = listAudit as ReturnType<typeof vi.fn>;

// The tenantless marker string is owned by the i18n bundle (added by the i18n maintainer under
// `audit.systemActor`); the view references it and the test supplies it so the assertion does not
// depend on the bundle landing first.
const SYSTEM_MARKER = 'Sistema';
const esWithMarker = { ...es, audit: { ...es.audit, systemActor: SYSTEM_MARKER } };
const enWithMarker = { ...en, audit: { ...en.audit, systemActor: 'System' } };

async function mountAudit(businessId: number | null) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore(pinia);
  auth.user = {
    id: 1, username: 'admin', email: null, role: 'Admin',
    business_id: businessId, is_active: true, must_change_password: false,
  };

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div/>' } }],
  });
  await router.push('/');
  await router.isReady();

  const i18n = createI18n({ legacy: false, locale: 'es', messages: { es: esWithMarker, en: enWithMarker } });
  const wrapper = mount(AuditView, { global: { plugins: [pinia, router, i18n] } });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  listAuditMock.mockReset();
  listAuditMock.mockResolvedValue({
    ok: true,
    meta: { page: 1, limit: LIST_DEFAULT_LIMIT, total: 2 },
    data: [
      {
        id: '1', business_id: '42', actor_user_id: '7', event_type: 'appointment_scheduled',
        entity_type: 'appointments', entity_id: '3', outcome: 'success', ip: null,
        details: null, created_at: '2026-01-01T12:00:00.000Z',
      },
      {
        id: '2', business_id: null, actor_user_id: null, event_type: 'login_failed_unknown_username',
        entity_type: null, entity_id: null, outcome: 'failure', ip: null,
        details: null, created_at: '2026-01-01T12:00:01.000Z',
      },
    ],
  });
});

describe('AuditView — the tenant column is super-admin only', () => {
  it('a super-admin sees the Negocio column with the tenant id and a Sistema marker for tenantless rows', async () => {
    const wrapper = await mountAudit(null);

    const headers = wrapper.findAll('th').map((th) => th.text());
    expect(headers).toContain(es.nav.business);

    const text = wrapper.text();
    expect(text).toContain('#42');
    expect(text).toContain(SYSTEM_MARKER);
  });

  it('a tenant Admin does not get the tenant column at all', async () => {
    const wrapper = await mountAudit(7);

    const headers = wrapper.findAll('th').map((th) => th.text());
    expect(headers).not.toContain(es.nav.business);
    // The system marker only exists inside that column, so it must be absent too.
    expect(wrapper.text()).not.toContain(SYSTEM_MARKER);
  });
});
