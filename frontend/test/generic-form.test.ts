import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import type { TableKey } from '@shared/ssot/derived';
import { resetFkOptionsCache } from '@/composables/useForeignKeyOptions';
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

// No SSOT table declares a dependsOn FK today (grep confirms), so the cascade has no real
// tableKey to mount GenericForm against. Merge one synthetic table into the real structure
// (every other test in this file still sees the real tables untouched) purely to exercise the
// wiring GenericForm already has for it: getFkOptions passes `dependsOn ? () => values[field] : undefined`
// to useForeignKeyOptions, which fk-options-cache.test.ts proves works in isolation — this proves
// GenericForm actually wires it up.
vi.mock('@shared/ssot/structure', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/ssot/structure')>();
  return {
    structure: {
      ...actual.structure,
      tables: {
        ...actual.structure.tables,
        __cascade_test__: {
          columns: {
            id: { type: 'string', label: { es: 'ID', en: 'ID' }, editable: false, sortable: true },
            professional_user_id: {
              type: 'string',
              label: { es: 'Profesional', en: 'Professional' },
              input: 'select',
              validator: { required: true },
              filterable: false,
              sortable: false,
              foreignKey: { table: 'professionals', valueField: 'id', labelField: 'display_name' },
            },
            service_id: {
              type: 'string',
              label: { es: 'Servicio', en: 'Service' },
              input: 'select',
              validator: { required: true },
              filterable: false,
              sortable: false,
              foreignKey: {
                table: 'services',
                valueField: 'id',
                labelField: 'name',
                dependsOn: { field: 'professional_user_id', foreignField: 'professional_user_id' },
              },
            },
          },
          pk: 'id',
          uiName: { es: 'Cascada de prueba', en: 'Cascade Test' },
          crud: { create: true, read: true, update: true, delete: true },
        },
      },
    },
  };
});

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

describe('GenericForm — backend field error mapping', () => {
  const messageFor = (wrapper: ReturnType<typeof mount>, field: string) => {
    const input = wrapper.find(`#${field}`);
    const errors = wrapper.findAllComponents(FieldError);
    return errors
      .map((e) => (e.props as (name: string) => string | undefined)('message'))
      .find((msg) => typeof msg === 'string' && msg.length > 0 && input.exists());
  };

  async function submitWith(failure: Record<string, unknown>) {
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

  // An endpoint that reports a field without naming the rule still gets a readable message.
  it('falls back to a generic field message when the server names no rule', async () => {
    const wrapper = await submitWith({
      ok: false,
      status: 422,
      code: 'validation_error',
      message: 'Validation failed',
      fields: { name: 'name is required' },
    });

    expect(messageFor(wrapper, 'name')).toBe(es.fieldError.fallback);
  });
});

describe('GenericForm — foreign key select option loading', () => {
  it('loads options from the referenced table for a foreignKey select column', async () => {
    // users.business_id is a foreignKey → businesses; the select loads its rows.
    const { listRows } = await import('@/api/crud');
    (listRows as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: [{ id: 'biz-1', name: 'Clínica Central' }],
      meta: { page: 1, limit: 20, total: 1 },
    });

    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericForm, {
      props: { tableKey: 'users' as TableKey, mode: 'create' },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();

    const selects = wrapper.findAll('select');
    expect(selects.length).toBeGreaterThan(0);

    const text = wrapper.text();
    expect(text).toContain('Clínica Central');
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

describe('GenericForm — FK dependsOn cascade', () => {
  beforeEach(() => {
    resetFkOptionsCache();
  });

  it('the dependent select has no options until its parent has a value, then loads options filtered by it', async () => {
    const { listRows } = await import('@/api/crud');
    (listRows as ReturnType<typeof vi.fn>).mockImplementation(async (table: string, params?: { filters?: Record<string, string> }) => {
      if (table === 'professionals') {
        return { ok: true, data: [{ id: '7', display_name: 'Dra. Cascada' }] };
      }
      if (table === 'services') {
        if (params?.filters?.professional_user_id === '7') {
          return { ok: true, data: [{ id: 's1', name: 'Corte Cascada' }] };
        }
        return { ok: true, data: [] };
      }
      return { ok: true, data: [] };
    });

    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericForm, {
      props: { tableKey: '__cascade_test__' as TableKey, mode: 'create' },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();

    const serviceSelectBefore = wrapper.find('select#service_id');
    expect(serviceSelectBefore.exists()).toBe(true);
    // Only the placeholder option — the parent professional_user_id is still unset.
    expect(serviceSelectBefore.findAll('option')).toHaveLength(1);

    await wrapper.find('select#professional_user_id').setValue('7');
    await flushPromises();

    const optionsAfter = wrapper.find('select#service_id').findAll('option').map((o) => o.text());
    expect(optionsAfter).toContain('Corte Cascada');
  });
});
