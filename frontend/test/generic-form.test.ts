import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { i18n as globalI18n } from '@/i18n';
import { useUiStore } from '@/stores/ui';
import type { TableKey } from '@shared/ssot/derived';
import { tableOf } from '@shared/utils/utils';
import type { ApiResult } from '@/api/client';
import {
  resetFkOptionsCache,
  FK_SEARCH_LIMIT,
  FK_SEARCH_DEBOUNCE_MS,
} from '@/composables/useForeignKeyOptions';
import DateField from '@/components/shared/DateField.vue';

vi.mock('@/api/crud', () => ({
  createRow: vi.fn().mockResolvedValue({ ok: true, data: { id: '99', name: 'Test' } }),
  updateRow: vi.fn().mockResolvedValue({ ok: true, data: { id: '1', name: 'Test' } }),
  listRows: vi.fn().mockResolvedValue({
    ok: true,
    data: [{ id: 'biz-1', name: 'Negocio A' }],
    meta: { page: 1, limit: 20, total: 1 },
  }),
  getRow: vi.fn(),
  deleteRow: vi.fn(),
}));

function makePlugins() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div/>' } }] });
  const i18n = createI18n({ legacy: false, locale: 'es', messages: { es, en } });
  return { pinia, router, i18n };
}

import GenericForm from '@/components/generic/GenericForm.vue';
import FieldError from '@/components/shared/FieldError.vue';

describe('GenericForm for services — input type mapping', () => {
  it('renders a text input for the name column', async () => {
    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericForm, {
      props: { tableKey: 'services' as TableKey, mode: 'create' },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();

    // SSOT: string column with no explicit input override renders a text input.
    const nameInput = wrapper.find('input#name') as ReturnType<typeof wrapper.find>;
    expect(nameInput.exists()).toBe(true);
    expect(nameInput.attributes('type')).toBe('text');
  });

  it('renders a textarea for the description column', async () => {
    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericForm, {
      props: { tableKey: 'services' as TableKey, mode: 'create' },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();

    const textarea = wrapper.find('textarea#description');
    expect(textarea.exists()).toBe(true);
  });

  it('renders a number input for default_duration_minutes', async () => {
    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericForm, {
      props: { tableKey: 'services' as TableKey, mode: 'create' },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();

    const numInput = wrapper.find('input#default_duration_minutes');
    expect(numInput.exists()).toBe(true);
    expect(numInput.attributes('type')).toBe('number');
  });
});

describe('GenericForm — advisory validateField on blur', () => {
  it('shows an inline FieldError when a required field is blurred empty', async () => {
    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericForm, {
      props: { tableKey: 'services' as TableKey, mode: 'create' },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();

    const nameInput = wrapper.find('input#name');
    expect(nameInput.exists()).toBe(true);

    await nameInput.trigger('blur');
    await flushPromises();

    const errors = wrapper.findAllComponents(FieldError);
    const nameError = errors.find((e) => {
      const msg = (e.props as (name: string) => string | undefined)('message');
      return msg && msg.length > 0;
    });
    expect(nameError).toBeDefined();
  });

  it('clears the error when a valid value is entered and blurred', async () => {
    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericForm, {
      props: { tableKey: 'services' as TableKey, mode: 'create' },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();

    const nameInput = wrapper.find('input#name');
    await nameInput.trigger('blur');
    await flushPromises();

    await nameInput.setValue('Corte simple');
    await nameInput.trigger('blur');
    await flushPromises();

    const errors = wrapper.findAllComponents(FieldError);
    const nonEmptyErrors = errors.filter((e) => {
      const msg = (e.props as (name: string) => string | undefined)('message');
      return msg && msg.length > 0;
    });
    expect(nonEmptyErrors.length).toBe(0);
  });
});

describe('GenericForm — the error is announced with its field, not just coloured', () => {
  it('marks the field invalid and points it at the message it belongs to', async () => {
    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericForm, {
      props: { tableKey: 'services' as TableKey, mode: 'create' },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();

    const nameInput = wrapper.find('input#name');
    expect(nameInput.attributes('aria-invalid')).toBeUndefined();
    expect(nameInput.attributes('aria-describedby')).toBeUndefined();

    await nameInput.trigger('blur');
    await flushPromises();

    const describedBy = nameInput.attributes('aria-describedby');
    expect(nameInput.attributes('aria-invalid')).toBe('true');
    expect(describedBy).toBeTruthy();

    const message = wrapper.find(`#${describedBy}`);
    expect(message.exists()).toBe(true);
    expect(message.attributes('role')).toBe('alert');
    expect(message.text()).toBe(es.fieldError.required);
  });

  it('drops both attributes once the value validates', async () => {
    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericForm, {
      props: { tableKey: 'services' as TableKey, mode: 'create' },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();

    const nameInput = wrapper.find('input#name');
    await nameInput.trigger('blur');
    await flushPromises();

    await nameInput.setValue('Corte simple');
    await nameInput.trigger('blur');
    await flushPromises();

    expect(nameInput.attributes('aria-invalid')).toBeUndefined();
    expect(nameInput.attributes('aria-describedby')).toBeUndefined();
  });
});

describe('GenericForm — backend field error mapping', () => {
  const messageFor = (wrapper: ReturnType<typeof mount>, field: string) => {
    const input = wrapper.find(`#${field}`);
    const errors = wrapper.findAllComponents(FieldError);
    return errors
      .map((e) => (e.props as (name: string) => string | undefined)('message'))
      .find((msg) => typeof msg === 'string' && msg.length > 0 && input.exists());
  };

  async function submitWith(failure: Extract<ApiResult<never>, { ok: false }>) {
    const { createRow } = await import('@/api/crud');
    (createRow as ReturnType<typeof vi.fn>).mockResolvedValueOnce(failure);

    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericForm, {
      props: { tableKey: 'services' as TableKey, mode: 'create' },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    return wrapper;
  }

  it('renders the field issue in the interface language, not the server prose', async () => {
    const wrapper = await submitWith({
      ok: false,
      status: 422,
      code: 'validation_error',
      message: 'Validation failed',
      fields: { name: 'name is required' },
      fieldDetails: { name: { key: 'required' } },
    });

    expect(messageFor(wrapper, 'name')).toBe(es.fieldError.required);
    expect(wrapper.text()).not.toContain('name is required');
  });

  // `fields` is the English diagnostic layer (logs, non-browser callers), never rendered. An
  // endpoint that names a field but no localizable rule must not fabricate a generic field
  // fallback — that masked the more specific top-level code. The code is surfaced instead.
  it('does not fabricate a field fallback from the English fields layer; surfaces the code', async () => {
    globalI18n.global.locale.value = 'es';
    const { createRow } = await import('@/api/crud');
    (createRow as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 422,
      code: 'validation_error',
      message: 'Validation failed',
      fields: { name: 'name is required' },
    });

    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericForm, {
      props: { tableKey: 'services' as TableKey, mode: 'create' },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();

    // Valid values for every required field so advisory client-side validation stays quiet and only
    // the server result drives the field state.
    await wrapper.find('input#name').setValue('Corte simple');
    await wrapper.find('input#default_duration_minutes').setValue(30);
    await wrapper.find('input#default_price_ars').setValue('1500.00');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(messageFor(wrapper, 'name')).toBeUndefined();
    expect(wrapper.text()).not.toContain('name is required');
    expect(useUiStore().toasts.at(-1)?.messageKey).toBe(es.apiError.code.validation_error);
  });
});

describe('GenericForm — foreign key select option loading', () => {
  beforeEach(() => {
    resetFkOptionsCache();
  });

  it('loads options from the referenced table for a foreignKey select column', async () => {
    // users.business_id is a foreignKey → businesses; the picker loads its rows.
    const { listRows } = await import('@/api/crud');
    (listRows as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: [
        { id: 'biz-1', name: 'Clínica Central' },
        { id: 'biz-2', name: 'Clínica Norte' },
      ],
      meta: { page: 1, limit: 20, total: 2 },
    });

    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericForm, {
      props: { tableKey: 'users' as TableKey, mode: 'create' },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();

    // Typing opens the list; the referenced rows are what it offers.
    await wrapper.find('input#business_id').setValue('clínica');
    const rendered = wrapper.findAll('[role=option]').map((o) => o.text());
    expect(rendered.some((t) => t.includes('Clínica Central'))).toBe(true);
  });
});

describe('GenericForm — uses shared validateField, not a reimplementation', () => {
  it('importable validateField returns undefined for a valid services name', async () => {
    const { validateField } = await import('@shared/validation/validate');
    expect(validateField('services', 'name', 'Corte simple')).toBeUndefined();
  });

  it('importable validateField returns an error for an empty required field', async () => {
    const { validateField } = await import('@shared/validation/validate');
    const err = validateField('services', 'name', '');
    expect(typeof err).toBe('string');
    expect(err!.length).toBeGreaterThan(0);
  });
});

describe('GenericForm — more input type mappings', () => {
  it('renders an email input for users.email', async () => {
    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericForm, {
      props: { tableKey: 'users' as TableKey, mode: 'create' },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();

    const emailInput = wrapper.find('input#email');
    expect(emailInput.exists()).toBe(true);
    expect(emailInput.attributes('type')).toBe('email');
  });

  it('renders a native select (options, not a FK) for users.role', async () => {
    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericForm, {
      props: { tableKey: 'users' as TableKey, mode: 'create' },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();

    const roleSelect = wrapper.find('select#role');
    expect(roleSelect.exists()).toBe(true);
    // Role options come straight from the SSOT ROLE_OPTIONS, not a fetched FK list.
    expect(roleSelect.text()).toContain('Cliente');
    expect(roleSelect.text()).toContain('Administrador');
  });

  it('renders a DateField for schedule_exceptions.exception_date', async () => {
    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericForm, {
      props: { tableKey: 'schedule_exceptions' as TableKey, mode: 'create' },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();

    expect(wrapper.findComponent(DateField).exists()).toBe(true);
  });
});

describe('GenericForm — readonlyOnEdit fields are excluded from the edit form', () => {
  it('drops the identity FK pair in edit mode but keeps other fields editable', async () => {
    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericForm, {
      props: {
        tableKey: 'professional_services' as TableKey,
        mode: 'edit',
        initial: { id: '1', professional_user_id: '5', service_id: '9', min_booking_days: 2, max_booking_days: 30 },
      },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();

    // readonlyOnEdit: settable at create, frozen after — the edit form neither offers them as
    // inputs nor shows them read-only (only editable:false columns get that treatment).
    expect(wrapper.find('select#professional_user_id').exists()).toBe(false);
    expect(wrapper.find('select#service_id').exists()).toBe(false);

    // The per-service booking-window override is a normal editable field, unaffected.
    expect(wrapper.find('input#min_booking_days').exists()).toBe(true);
    expect(wrapper.find('input#max_booking_days').exists()).toBe(true);
  });
});

describe('GenericForm — full-object validation runs on submit, not just on blur', () => {
  it('populates every invalid field error on submit even when no field was individually blurred', async () => {
    const { createRow } = await import('@/api/crud');
    (createRow as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, data: { id: '1', name: '' } });

    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericForm, {
      props: { tableKey: 'services' as TableKey, mode: 'create' },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();

    // Required fields (name, default_duration_minutes) are left empty; blur is never triggered.
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    const errors = wrapper.findAllComponents(FieldError);
    const populated = errors.filter((e) => {
      const msg = (e.props as (name: string) => string | undefined)('message');
      return !!msg && msg.length > 0;
    });
    expect(populated.length).toBeGreaterThan(0);

    // Advisory only — validateFullObject failing does not block the submit; the backend call
    // still fires (its own field errors would only replace these if it came back non-ok).
    expect(createRow).toHaveBeenCalled();
  });
});

describe('GenericForm — a referenced id beyond the first page stays selectable', () => {
  beforeEach(() => {
    resetFkOptionsCache();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks the server for what was typed and offers the match the first page never carried', async () => {
    const { listRows } = await import('@/api/crud');
    (listRows as ReturnType<typeof vi.fn>).mockImplementation(
      async (_table: string, params?: { filters?: Record<string, string> }) => {
        // Past the cap: only a query finds it.
        if (params?.filters?.name === 'zar') {
          return { ok: true, data: [{ id: 'biz-999', name: 'Clínica Zaráte' }] };
        }
        return { ok: true, data: [{ id: 'biz-1', name: 'Clínica Central' }] };
      },
    );

    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericForm, {
      props: { tableKey: 'users' as TableKey, mode: 'create' },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();

    // users.business_id is a foreignKey → businesses, rendered as a searchable picker.
    const input = wrapper.find('input#business_id');
    expect(input.exists()).toBe(true);

    await input.setValue('zar');
    await vi.advanceTimersByTimeAsync(FK_SEARCH_DEBOUNCE_MS);
    await flushPromises();

    expect(listRows).toHaveBeenCalledWith('businesses', {
      filters: { name: 'zar' },
      limit: FK_SEARCH_LIMIT,
      includeUnrelated: true,
    });
    const rendered = wrapper.findAll('[role=option]').map((o) => o.text());
    expect(rendered.some((t) => t.includes('Clínica Zaráte'))).toBe(true);
  });
});

// The readonlyOnEdit tests above cover fields dropped entirely; these cover the read-only block
// specifically: internal plumbing (pk, business_id) must never render there, while a genuinely
// useful editable:false field (email, username) still does.
describe('GenericForm — internal identity/tenant columns never appear in the read-only block', () => {
  const readOnlyLabels = (wrapper: ReturnType<typeof mount>) =>
    wrapper.findAll('span.text-sm.font-semibold.text-neutral').map((s) => s.text());

  it('renders neither pk nor business_id for a table whose descriptor carries both', async () => {
    // services: pk + business_id, no other editable:false column: the read-only block must be
    // entirely empty, not just missing a label.
    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericForm, {
      props: {
        tableKey: 'services' as TableKey,
        mode: 'edit',
        initial: {
          id: 'svc-internal-77',
          business_id: 'biz-internal-42',
          name: 'Corte',
          description: null,
          default_duration_minutes: 30,
          default_price_ars: '1500.00',
        },
      },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();

    expect(readOnlyLabels(wrapper)).toEqual([]);
    expect(wrapper.text()).not.toContain('svc-internal-77');
    expect(wrapper.text()).not.toContain('biz-internal-42');
  });

  it('hides the pk while still rendering the genuinely read-only email and username fields', async () => {
    // clients: pk plus two legitimate editable:false fields (email, username): only the pk
    // is internal plumbing, so the other two must survive the filter.
    const clientsSpec = tableOf('clients');
    const labelOf = (field: string) => {
      const col = clientsSpec.columns[field];
      if (!col?.label) throw new Error(`clients.${field} has no label`);
      return col.label.es;
    };
    const emailLabel = labelOf('email');
    const usernameLabel = labelOf('username');

    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericForm, {
      props: {
        tableKey: 'clients' as TableKey,
        mode: 'edit',
        initial: {
          id: 'client-internal-501',
          display_name: 'Juan Pérez',
          email: 'juan@example.com',
          dni: null,
          username: 'juanp',
          phone: null,
          notes: null,
        },
      },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();

    expect(wrapper.text()).not.toContain('client-internal-501');
    expect(readOnlyLabels(wrapper)).toEqual([emailLabel, usernameLabel]);
    expect(wrapper.text()).toContain('juan@example.com');
    expect(wrapper.text()).toContain('juanp');
  });
});
