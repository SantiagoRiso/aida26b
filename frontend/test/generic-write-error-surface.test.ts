import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { i18n as globalI18n } from '@/i18n';
import { apiErrorMessage } from '@/i18n/api-errors';
import { useUiStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import type { AuthUser } from '@shared/ssot/contracts/auth';
import type { TableKey } from '@shared/ssot/derived';
import type { ApiResult } from '@/api/client';

// A failed generic write used to fall back to a single opaque toast ("Ocurrió un error…") whenever
// it carried no per-field errors — even when its top-level code had a perfectly good translation.
// These prove the translated code now reaches the user, and that the appointment workflow's
// parametrized reasons interpolate their runtime value.

vi.mock('@/api/crud', () => ({
  createRow: vi.fn().mockResolvedValue({ ok: true, data: { id: '1', name: 'Test' } }),
  updateRow: vi.fn().mockResolvedValue({ ok: true, data: { id: '1', name: 'Test' } }),
  listRows: vi.fn().mockResolvedValue({ ok: true, data: [], meta: { page: 1, limit: 20, total: 0 } }),
  getRow: vi.fn(),
  deleteRow: vi.fn().mockResolvedValue({ ok: true }),
}));

function makePlugins() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div/>' } }] });
  const i18n = createI18n({ legacy: false, locale: 'es', messages: { es, en } });
  globalI18n.global.locale.value = 'es';
  return { pinia, router, i18n };
}

import GenericForm from '@/components/generic/GenericForm.vue';
import CrudSection from '@/components/generic/CrudSection.vue';

async function submitServices(failure: Extract<ApiResult<never>, { ok: false }>) {
  const { createRow } = await import('@/api/crud');
  (createRow as ReturnType<typeof vi.fn>).mockResolvedValueOnce(failure);

  const { pinia, router, i18n } = makePlugins();
  const wrapper = mount(GenericForm, {
    props: { tableKey: 'services' as TableKey, mode: 'create' },
    global: { plugins: [pinia, router, i18n] },
  });
  await flushPromises();
  // Valid values so advisory client validation stays quiet; only the server result drives the toast.
  await wrapper.find('input#name').setValue('Corte simple');
  await wrapper.find('input#default_duration_minutes').setValue(30);
  await wrapper.find('form').trigger('submit');
  await flushPromises();
  return wrapper;
}

describe('GenericForm — a failed write surfaces the translated top-level code (M6)', () => {
  it('a duplicate name (409 conflict) shows the conflict message, not the generic toast', async () => {
    await submitServices({ ok: false, status: 409, code: 'conflict', message: 'Resource already exists' });

    const toast = useUiStore().toasts.at(-1);
    expect(toast?.messageKey).toBe(es.apiError.code.conflict);
    expect(toast?.messageKey).not.toBe(es.toast.genericError);
  });

  it('an operation_not_allowed (405) shows its own message', async () => {
    await submitServices({ ok: false, status: 405, code: 'operation_not_allowed', message: 'not allowed' });
    expect(useUiStore().toasts.at(-1)?.messageKey).toBe(es.apiError.code.operation_not_allowed);
  });

  // crud-policy sends invalid_reference_role with a `fields` (English) map but no fieldDetails.
  // The English prose must never render, and the specific top-level code is shown instead of a
  // fabricated field fallback (M8).
  it('a fields-only invalid_reference_role surfaces the code, never the English prose', async () => {
    const wrapper = await submitServices({
      ok: false,
      status: 422,
      code: 'invalid_reference_role',
      message: 'professional_user_id must reference an active Professional',
      fields: { professional_user_id: 'must be an active Professional' },
    });

    expect(useUiStore().toasts.at(-1)?.messageKey).toBe(es.apiError.code.invalid_reference_role);
    expect(wrapper.text()).not.toContain('must be an active Professional');
  });

  it('still falls back to the generic toast when neither detail nor code resolves', async () => {
    await submitServices({ ok: false, status: 500, code: 'some_unmapped_code', message: 'boom' });
    expect(useUiStore().toasts.at(-1)?.messageKey).toBe(es.toast.genericError);
  });
});

describe('CrudSection — a blocked delete surfaces the translated code (M6)', () => {
  const adminUser: AuthUser = {
    id: 1, username: 'admin', email: null, role: 'Admin',
    business_id: 1, is_active: true, must_change_password: false,
  };

  // DetailPanel wraps its content in a Headless UI dialog that renders empty under jsdom, so the
  // delete button never reaches the DOM. Stub the chrome to a plain slot to reach the button.
  const DetailPanelStub = {
    name: 'DetailPanel',
    props: ['open', 'title'],
    template: '<div v-if="open"><slot /></div>',
  };

  function mountSection(): VueWrapper {
    const { pinia, router, i18n } = makePlugins();
    useAuthStore().user = adminUser;
    return mount(CrudSection, {
      props: {
        tableKey: 'services' as TableKey,
        panelTitle: { es: 'Servicio', en: 'Service' },
        deleteLabel: { es: 'Eliminar servicio', en: 'Delete service' },
        deleteBody: { es: '¿Confirmás?', en: 'Confirm?' },
      },
      global: { plugins: [pinia, router, i18n], stubs: { DetailPanel: DetailPanelStub } },
    });
  }

  it('an FK-blocked delete (409 conflict) shows the conflict message', async () => {
    const { deleteRow } = await import('@/api/crud');
    (deleteRow as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false, status: 409, code: 'conflict', message: 'Resource in use',
    });

    const wrapper = mountSection();
    await flushPromises();

    // Open the edit panel for a row so its delete control renders. Name selectors keep
    // findComponent on the VueWrapper overload (the generic SFC's own type resolves to DOMWrapper).
    wrapper.findComponent({ name: 'GenericTable' }).vm.$emit('edit', { id: '7', name: 'Corte' });
    await flushPromises();

    const deleteButton = wrapper.findAll('button').find((b) => b.text().includes('Eliminar servicio'));
    expect(deleteButton).toBeDefined();
    await deleteButton!.trigger('click');
    await flushPromises();

    // The confirm dialog is also Headless UI chrome; drive it through its event, not its DOM.
    wrapper.findComponent({ name: 'ConfirmDialog' }).vm.$emit('confirm');
    await flushPromises();

    expect(deleteRow).toHaveBeenCalledWith('services', '7');
    const toast = useUiStore().toasts.at(-1);
    expect(toast?.messageKey).toBe(es.apiError.code.conflict);
    expect(toast?.messageKey).not.toBe(es.toast.genericError);
  });
});

describe('apiErrorMessage — appointment detail keys interpolate their runtime value (M7)', () => {
  beforeEach(() => {
    globalI18n.global.locale.value = 'es';
  });

  it('outside_cutoff renders the cutoff hours', () => {
    const msg = apiErrorMessage({
      ok: false, status: 422, code: 'outside_cutoff',
      message: 'Cancellation is only allowed at least 24 hour(s) before the appointment',
      detail: { key: 'cancelCutoff', params: { hours: 24 } },
    });
    expect(msg).toContain('24');
    expect(msg).not.toContain('{hours}');
    // The coarse code fallback carried no number.
    expect(msg).not.toBe(es.apiError.code.outside_cutoff);
  });

  it('no_show too_early renders the cutoff hours', () => {
    const msg = apiErrorMessage({
      ok: false, status: 422, code: 'too_early',
      message: "Cannot mark 'no_show' more than 48 hour(s) before the appointment",
      detail: { key: 'noShowTooEarly', params: { hours: 48 } },
    });
    expect(msg).toContain('48');
    expect(msg).not.toContain('{hours}');
  });

  it('completed too_early resolves its own message (no params)', () => {
    const msg = apiErrorMessage({
      ok: false, status: 422, code: 'too_early',
      message: "Cannot mark 'completed' before the appointment's start time",
      detail: { key: 'completeTooEarly' },
    });
    expect(msg).toBe(es.apiError.completeTooEarly);
  });
});

// A duplicate-constraint conflict used to collapse to the generic "Ya existe un registro con esos
// datos." (apiError.code.conflict) no matter which rule fired — see
// shared/src/ssot/domain/constraint-messages.ts for the backend side of this mapping. These prove
// the specific detail.key wins over the coarse code, for every surface the maintainer asked to be
// precise (admin user creation) plus a sample of the swept adjacent cases.
describe('apiErrorMessage — constraint-conflict detail keys resolve to a precise message, not the generic conflict text (M9)', () => {
  beforeEach(() => {
    globalI18n.global.locale.value = 'es';
  });

  it.each([
    ['usernameTaken', es.apiError.usernameTaken],
    ['emailTaken', es.apiError.emailTaken],
    ['dniTaken', es.apiError.dniTaken],
    ['grantAlreadyExists', es.apiError.grantAlreadyExists],
    ['serviceAlreadyOffered', es.apiError.serviceAlreadyOffered],
    ['clientPriceOverrideExists', es.apiError.clientPriceOverrideExists],
    ['blockServiceAlreadyOffered', es.apiError.blockServiceAlreadyOffered],
    ['chargeAlreadyPosted', es.apiError.chargeAlreadyPosted],
    ['scheduleOwnerExactlyOne', es.apiError.scheduleOwnerExactlyOne],
    ['exceptionGranularityRequired', es.apiError.exceptionGranularityRequired],
  ] as const)('detail.key %s resolves to its own apiError string, not the generic conflict text', (key, expected) => {
    const msg = apiErrorMessage({
      ok: false, status: 409, code: 'conflict', message: 'Resource already exists',
      detail: { key },
    });
    expect(msg).toBe(expected);
    expect(msg).not.toBe(es.apiError.code.conflict);
  });

  it('an unmapped constraint (no detail) still falls back to the generic conflict text', () => {
    const msg = apiErrorMessage({
      ok: false, status: 409, code: 'conflict', message: 'Resource already exists',
    });
    expect(msg).toBe(es.apiError.code.conflict);
  });

  it('en locale resolves the same keys to the English strings', () => {
    globalI18n.global.locale.value = 'en';
    const msg = apiErrorMessage({
      ok: false, status: 409, code: 'conflict', message: 'Resource already exists',
      detail: { key: 'usernameTaken' },
    });
    expect(msg).toBe(en.apiError.usernameTaken);
    expect(msg).not.toBe(en.apiError.code.conflict);
  });
});
