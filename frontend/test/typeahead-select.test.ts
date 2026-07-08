import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import TypeaheadSelect from '@/components/shared/TypeaheadSelect.vue';

interface ProfOpt { value: string; label: string; services: string }

const options: ProfOpt[] = [
  { value: '1', label: 'Dra. Marge Bouvier', services: 'Sesión individual' },
  { value: '2', label: 'Dr. Nick Riviera', services: 'Sesión de kinesiología' },
  { value: '3', label: 'Dra. Lisa Simpson', services: 'Consulta nutricional' },
];

function openAndQuery(wrapper: ReturnType<typeof mount>, text: string) {
  const input = wrapper.get('input');
  // HeadlessUI opens the listbox on input; @change drives the internal query.
  return input.setValue(text);
}

describe('TypeaheadSelect', () => {
  it('shows the label of the currently selected value in the input', () => {
    const wrapper = mount(TypeaheadSelect, {
      props: { modelValue: '2', options },
    });
    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('Dr. Nick Riviera');
  });

  it('renders an empty input when nothing is selected', () => {
    const wrapper = mount(TypeaheadSelect, {
      props: { modelValue: null, options },
    });
    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('');
  });

  it('filters options by label substring', async () => {
    const wrapper = mount(TypeaheadSelect, {
      props: { modelValue: null, options },
    });
    await openAndQuery(wrapper, 'nick');
    const rendered = wrapper.findAll('[role=option]').map((o) => o.text());
    expect(rendered.some((t) => t.includes('Nick Riviera'))).toBe(true);
    expect(rendered.some((t) => t.includes('Marge'))).toBe(false);
  });

  it('filters by extraSearch so a service name surfaces its professional', async () => {
    const wrapper = mount(TypeaheadSelect, {
      props: { modelValue: null, options, extraSearch: (o: ProfOpt) => o.services },
    });
    await openAndQuery(wrapper, 'kinesio');
    const rendered = wrapper.findAll('[role=option]').map((o) => o.text());
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toContain('Nick Riviera');
  });

  it('emits update:modelValue with the option value when one is chosen', async () => {
    const wrapper = mount(TypeaheadSelect, {
      props: { modelValue: null, options },
    });
    const input = wrapper.get('input');
    await openAndQuery(wrapper, 'lisa');
    // The sole match is the active option; Enter commits it (jsdom lacks the pointer events
    // HeadlessUI's mouse selection relies on).
    await input.trigger('keydown', { key: 'Enter' });
    const emitted = wrapper.emitted('update:modelValue');
    expect(emitted).toBeTruthy();
    expect(emitted![emitted!.length - 1]).toEqual(['3']);
  });
});
