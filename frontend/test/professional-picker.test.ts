import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { listRows } from '@/api/crud';
import ProfessionalPicker from '@/components/schedule/ProfessionalPicker.vue';

vi.mock('@/api/crud', () => ({ listRows: vi.fn() }));

const makeI18n = () => createI18n({ legacy: false, locale: 'es', messages: { es, en } });

function mountPicker() {
  return mount(ProfessionalPicker, { props: { modelValue: null }, global: { plugins: [makeI18n()] } });
}

// The picker delegates to the shared Selector, which collapses a lone option to a label and
// auto-selects it. These cover the wiring (number id ⇄ string value) and the collapse.
describe('ProfessionalPicker', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('renders a dropdown and does not auto-select when several professionals are available', async () => {
    vi.mocked(listRows).mockResolvedValue({
      ok: true,
      data: [{ id: '1', display_name: 'Dr. Ana' }, { id: '2', display_name: 'Dr. Bruno' }],
    });
    const wrapper = mountPicker();
    await flushPromises();

    const select = wrapper.get('select');
    expect(select.findAll('option').length).toBe(3); // disabled placeholder + 2 professionals
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it('collapses a single professional to a label and auto-selects it (as a number)', async () => {
    vi.mocked(listRows).mockResolvedValue({
      ok: true,
      data: [{ id: '3', display_name: 'Dra. Marge Bouvier' }],
    });
    const wrapper = mountPicker();
    await flushPromises();

    expect(wrapper.find('select').exists()).toBe(false);
    expect(wrapper.text()).toContain('Dra. Marge Bouvier');
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([3]);
  });
});

function mountAllPicker(modelValue: number | null = null) {
  return mount(ProfessionalPicker, { props: { modelValue, allowAll: true }, global: { plugins: [makeI18n()] } });
}

// allowAll turns the picker into a filter: an "all professionals" (null) entry, no auto-lock, and
// it hides itself when filtering would be meaningless (a single calendar in scope).
describe('ProfessionalPicker (allowAll filter mode)', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('prepends an "all" option and starts unfiltered when several professionals exist', async () => {
    vi.mocked(listRows).mockResolvedValue({
      ok: true,
      data: [{ id: '3', display_name: 'Dra. Marge' }, { id: '4', display_name: 'Dr. Ned' }],
    });
    const wrapper = mountAllPicker();
    await flushPromises();

    const options = wrapper.get('select').findAll('option');
    expect(options.length).toBe(3);
    expect(options.some((option) => option.element.value === '')).toBe(false);
    expect(wrapper.text()).toContain('Todos los profesionales');
    // Defaults to "all" — no filter forced on the caller.
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it('hides itself when a single professional is in scope (filtering is meaningless)', async () => {
    vi.mocked(listRows).mockResolvedValue({
      ok: true,
      data: [{ id: '3', display_name: 'Dra. Marge' }],
    });
    const wrapper = mountAllPicker();
    await flushPromises();

    expect(wrapper.find('select').exists()).toBe(false);
    expect(wrapper.find('label').exists()).toBe(false);
  });

  it('emits the numeric id when a professional is picked and null for "all"', async () => {
    vi.mocked(listRows).mockResolvedValue({
      ok: true,
      data: [{ id: '3', display_name: 'Dra. Marge' }, { id: '4', display_name: 'Dr. Ned' }],
    });
    const wrapper = mountAllPicker();
    await flushPromises();

    await wrapper.get('select').setValue('4');
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([4]);

    await wrapper.get('select').setValue('all');
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([null]);
  });
});
