import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import type { TableKey } from '@shared/types/types';

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

describe('GenericForm — backend field error mapping', () => {
  it('maps backend {fields:{name: error}} to inline FieldError under name input', async () => {
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

    await wrapper.find('form').trigger('submit');
    await flushPromises();

    const errors = wrapper.findAllComponents(FieldError);
    const nameErr = errors.find((e) => {
      const msg = (e.props as (name: string) => string | undefined)('message');
      return typeof msg === 'string' && msg.includes('name');
    });
    expect(nameErr).toBeDefined();
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
