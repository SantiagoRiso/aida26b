import { describe, it, expect } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import Selector from '@/components/shared/Selector.vue';
import { es } from '@/i18n/es';

interface ProfOpt { value: string; label: string; services: string }

const options: ProfOpt[] = [
  { value: '1', label: 'Dra. Marge Bouvier', services: 'Sesión de Psicología Infantil' },
  { value: '2', label: 'Dr. Nick Riviera', services: 'Sesión de kinesiología' },
  { value: '3', label: 'Dra. Lisa Simpson', services: 'Consulta nutricional' },
];

function openAndQuery(wrapper: ReturnType<typeof mount>, text: string) {
  // HeadlessUI opens the listbox on input; @change drives the internal query.
  return wrapper.get('input').setValue(text);
}

describe('Selector — searchable (typeahead)', () => {
  it('shows the label of the currently selected value in the input', () => {
    const wrapper = mount(Selector, { props: { modelValue: '2', options, searchable: true } });
    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('Dr. Nick Riviera');
  });

  it('renders an empty input when nothing is selected', () => {
    const wrapper = mount(Selector, { props: { modelValue: null, options, searchable: true } });
    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('');
  });

  it('filters options by label substring', async () => {
    const wrapper = mount(Selector, { props: { modelValue: null, options, searchable: true } });
    await openAndQuery(wrapper, 'nick');
    const rendered = wrapper.findAll('[role=option]').map((o) => o.text());
    expect(rendered.some((t) => t.includes('Nick Riviera'))).toBe(true);
    expect(rendered.some((t) => t.includes('Marge'))).toBe(false);
  });

  it('filters by extraSearch so a service name surfaces its professional', async () => {
    const wrapper = mount(Selector, {
      props: {
        modelValue: null, options, searchable: true,
        extraSearch: (o: { value: string }) => options.find((p) => p.value === o.value)?.services ?? '',
      },
    });
    await openAndQuery(wrapper, 'kinesio');
    const rendered = wrapper.findAll('[role=option]').map((o) => o.text());
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toContain('Nick Riviera');
  });

  it('clears the filter after a selection so reopening shows every option', async () => {
    const wrapper = mount(Selector, { props: { modelValue: null, options, searchable: true } });
    await openAndQuery(wrapper, 'lisa');
    expect(wrapper.findAll('[role=option]')).toHaveLength(1);
    await wrapper.setProps({ modelValue: '3' });
    // Close, then reopen without typing: the old query must not still be filtering.
    await wrapper.get('button').trigger('click');
    await wrapper.get('button').trigger('click');
    expect(wrapper.findAll('[role=option]')).toHaveLength(options.length);
  });

  it('clears the filter when the input is left without choosing', async () => {
    const wrapper = mount(Selector, { props: { modelValue: null, options, searchable: true } });
    await openAndQuery(wrapper, 'lisa');
    await wrapper.get('input').trigger('blur');
    await wrapper.get('button').trigger('click');
    expect(wrapper.findAll('[role=option]')).toHaveLength(options.length);
  });

  it('emits update:modelValue with the option value when one is chosen', async () => {
    const wrapper = mount(Selector, { props: { modelValue: null, options, searchable: true } });
    const input = wrapper.get('input');
    await openAndQuery(wrapper, 'lisa');
    await input.trigger('keydown', { key: 'Enter' });
    const emitted = wrapper.emitted('update:modelValue');
    expect(emitted![emitted!.length - 1]).toEqual(['3']);
  });
});

describe('Selector — plain list', () => {
  it('renders a <select> when not searchable and emits on change', async () => {
    const wrapper = mount(Selector, { props: { modelValue: null, options } });
    expect(wrapper.find('select').exists()).toBe(true);
    expect(wrapper.find('input').exists()).toBe(false);
    await wrapper.get('select').setValue('2');
    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual(['2']);
  });
});

describe('Selector — labelIfSingle', () => {
  it('renders a lone option as a read-only label and auto-selects it', async () => {
    const one = [{ value: '9', label: 'Only Option' }];
    const wrapper = mount(Selector, { props: { modelValue: null, options: one } });
    await flushPromises();
    expect(wrapper.find('select').exists()).toBe(false);
    expect(wrapper.find('input').exists()).toBe(false);
    expect(wrapper.text()).toContain('Only Option');
    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual(['9']);
  });

  it('does not collapse when labelIfSingle is disabled', () => {
    const one = [{ value: '9', label: 'Only Option' }];
    const wrapper = mount(Selector, { props: { modelValue: null, options: one, labelIfSingle: false } });
    expect(wrapper.find('select').exists()).toBe(true);
  });
});

describe('Selector — defaultValue (soft pre-select)', () => {
  it('applies the default when nothing is chosen, leaving it editable', async () => {
    const wrapper = mount(Selector, { props: { modelValue: null, options, defaultValue: '2' } });
    await flushPromises();
    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual(['2']);
    expect(wrapper.find('select').exists()).toBe(true); // still a real, changeable control
  });

  it('does not override an existing selection', async () => {
    const wrapper = mount(Selector, { props: { modelValue: '3', options, defaultValue: '2' } });
    await flushPromises();
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });
});

describe('Selector — readonly', () => {
  it('renders a locked label and never auto-changes the value', async () => {
    const wrapper = mount(Selector, { props: { modelValue: '2', options, readonly: true } });
    await flushPromises();
    expect(wrapper.find('select').exists()).toBe(false);
    expect(wrapper.find('input').exists()).toBe(false);
    expect(wrapper.text()).toContain('Dr. Nick Riviera');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });
});

describe('Selector — server-side search', () => {
  it('reports what was typed so the owner can answer it from the server', async () => {
    const wrapper = mount(Selector, { props: { modelValue: null, options, searchable: true } });
    await openAndQuery(wrapper, 'zar');
    expect(wrapper.emitted('search')!.at(-1)).toEqual(['zar']);
  });

  it('says the options are still arriving instead of "no results"', async () => {
    const wrapper = mount(Selector, {
      props: { modelValue: null, options: [] as ProfOpt[], searchable: true, loading: true },
    });
    await openAndQuery(wrapper, 'zar');
    expect(wrapper.text()).toContain(es.loading);
    expect(wrapper.text()).not.toContain(es.selector.noResults);
  });
});
