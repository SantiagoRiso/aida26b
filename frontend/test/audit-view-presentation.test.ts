import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { useAuthStore } from '@/stores/auth';
import { LIST_DEFAULT_LIMIT } from '@shared/ssot/list-protocol';
import { AUDIT_OUTCOMES } from '@shared/ssot/domain';
import { auditEventLabel } from '@shared/ssot/domain/audit-events';

vi.mock('@/api/audit', () => ({ listAudit: vi.fn() }));

import AuditView from '@/views/staff/AuditView.vue';
import { listAudit } from '@/api/audit';
import type { AuditEvent } from '@/api/audit';

const listAuditMock = listAudit as ReturnType<typeof vi.fn>;

async function mountAudit(events: AuditEvent[]) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore(pinia);
  auth.user = {
    id: 1, username: 'admin', email: null, role: 'Admin',
    business_id: 7, is_active: true, must_change_password: false,
  };

  listAuditMock.mockReset();
  listAuditMock.mockResolvedValue({
    ok: true,
    meta: { page: 1, limit: LIST_DEFAULT_LIMIT, total: events.length },
    data: events,
  });

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div/>' } }],
  });
  await router.push('/');
  await router.isReady();

  const i18n = createI18n({ legacy: false, locale: 'es', messages: { es, en } });
  const wrapper = mount(AuditView, { global: { plugins: [pinia, router, i18n] } });
  await flushPromises();
  return wrapper;
}

function baseEvent(overrides: Partial<AuditEvent>): AuditEvent {
  return {
    id: '1', business_id: '7', actor_user_id: '9', actor_username: 'recep_ana',
    entity_label: null, event_type: 'appointment_scheduled', entity_type: 'appointments', entity_id: '3',
    outcome: 'success', ip: null, details: null, created_at: '2026-01-01T12:00:00.000Z',
    ...overrides,
  };
}

describe('AuditView — event_type reads as language, not a raw identifier', () => {
  it('a composed event type (generic CRUD create on a non-protected table) renders its SSOT label', async () => {
    const wrapper = await mountAudit([baseEvent({ event_type: 'services_created' })]);

    const composed = auditEventLabel('services_created');
    expect(composed).not.toBeNull();
    expect(wrapper.text()).toContain(composed!.es);
    // The raw identifier stays reachable (it's what the event-type filter matches on).
    expect(wrapper.find('[title="services_created"]').exists()).toBe(true);
  });

  it('an event type with no bespoke entry and no matching composition rule falls back to the raw string', async () => {
    const wrapper = await mountAudit([baseEvent({ event_type: 'totally_unknown_event' })]);

    expect(auditEventLabel('totally_unknown_event')).toBeNull();
    expect(wrapper.text()).toContain('totally_unknown_event');
  });
});

describe('AuditView — outcome reads as language', () => {
  it('renders the same translated outcome the filter dropdown uses', async () => {
    const wrapper = await mountAudit([baseEvent({ outcome: 'denied' })]);

    const deniedOption = AUDIT_OUTCOMES.find((o) => o.value === 'denied');
    expect(wrapper.text()).toContain(deniedOption!.label.es);
    // The raw English value must not leak into the outcome badge itself.
    const outcomeCell = wrapper.findAll('tbody tr')[0].findAll('td').at(-2);
    expect(outcomeCell!.text()).not.toContain('denied');
  });
});

describe('AuditView — details surface the reason on a denied row', () => {
  it('shows the translated denial reason instead of leaving the reader with just "denied"', async () => {
    const wrapper = await mountAudit([baseEvent({
      event_type: 'appointment_action_denied',
      outcome: 'denied',
      details: { reason: 'forbidden', entity_id: 5 },
    })]);

    expect(wrapper.text()).toContain(es.audit.details.reasonLabel);
    expect(wrapper.text()).toContain(es.apiError.code.forbidden);
  });

  it('renders nothing in the details cell for a row with no details', async () => {
    const wrapper = await mountAudit([baseEvent({ details: null })]);

    const detailsCell = wrapper.findAll('tbody tr')[0].findAll('td').at(-1);
    expect(detailsCell!.text()).toBe('');
  });
});
