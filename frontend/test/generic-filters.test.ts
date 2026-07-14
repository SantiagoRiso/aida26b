import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { structure } from '@shared/ssot/structure';
import type { TableKey } from '@shared/ssot/derived';
import GenericFilters from '@/components/generic/GenericFilters.vue';

// GenericFilters needs no auth/router: Pinia backs useLabel() (SSOT column labels follow
// ui.language), and vue-i18n backs the chrome strings (Agregar, excluir, mín/máx…).
function mountFilters(tableKey: TableKey) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const i18n = createI18n({ legacy: false, locale: 'es', messages: { es, en } });
  return mount(GenericFilters, { props: { tableKey }, global: { plugins: [pinia, i18n] } });
}

const columnSelect = (wrapper: ReturnType<typeof mountFilters>) =>
  wrapper.get(`select[aria-label="${es.generic.selectColumnAria}"]`);

async function addFilter(wrapper: ReturnType<typeof mountFilters>, field: string) {
  await columnSelect(wrapper).setValue(field);
  await wrapper.get('button').trigger('click'); // the only button before a row exists is "Agregar"
}

function lastChange(wrapper: ReturnType<typeof mountFilters>): Record<string, string> {
  const events = wrapper.emitted('change');
  expect(events).toBeTruthy();
  return events![events!.length - 1][0] as Record<string, string>;
}

describe('GenericFilters — add filter by column', () => {
  it('adds a filter row for the selected column and disables it from being picked again', async () => {
    const wrapper = mountFilters('services' as TableKey);
    await addFilter(wrapper, 'name');

    expect(wrapper.text()).toContain('Nombre');
    const nameOption = wrapper.findAll('option').find((o) => o.text() === 'Nombre');
    expect(nameOption?.attributes('disabled')).toBeDefined();
    // The column picker resets to its placeholder after adding.
    expect(columnSelect(wrapper).element.value).toBe('');
  });

  it('the Agregar button is disabled until a column is selected', () => {
    const wrapper = mountFilters('services' as TableKey);
    const addButton = wrapper.get('button');
    expect(addButton.attributes('disabled')).toBeDefined();
  });
});

describe('GenericFilters — text filter', () => {
  it('serializes a plain text value under its field name', async () => {
    const wrapper = mountFilters('services' as TableKey);
    await addFilter(wrapper, 'name');

    const textInput = wrapper.get(`input[placeholder="${es.generic.filterPlaceholder}"]`);
    await textInput.setValue('corte');

    expect(lastChange(wrapper)).toEqual({ name: 'corte' });
  });
});

describe('GenericFilters — negation (exclude)', () => {
  it('prefixes the serialized value with ! once the exclude checkbox is checked', async () => {
    const wrapper = mountFilters('services' as TableKey);
    await addFilter(wrapper, 'name');

    const textInput = wrapper.get(`input[placeholder="${es.generic.filterPlaceholder}"]`);
    await textInput.setValue('corte');
    expect(lastChange(wrapper)).toEqual({ name: 'corte' });

    await wrapper.get('input[type="checkbox"]').setValue(true);
    expect(lastChange(wrapper)).toEqual({ name: '!corte' });

    // Unchecking drops the prefix again.
    await wrapper.get('input[type="checkbox"]').setValue(false);
    expect(lastChange(wrapper)).toEqual({ name: 'corte' });
  });
});

describe('GenericFilters — numeric range', () => {
  it('serializes min/max as "min,max", tolerating either bound being blank', async () => {
    const wrapper = mountFilters('services' as TableKey);
    await addFilter(wrapper, 'default_duration_minutes');

    const minInput = wrapper.get(`input[placeholder="${es.generic.minPlaceholder}"]`);
    const maxInput = wrapper.get(`input[placeholder="${es.generic.maxPlaceholder}"]`);

    await minInput.setValue('10');
    expect(lastChange(wrapper)).toEqual({ default_duration_minutes: '10,' });

    await maxInput.setValue('60');
    expect(lastChange(wrapper)).toEqual({ default_duration_minutes: '10,60' });
  });

  it('a negated numeric range keeps the ! prefix on the "min,max" pair', async () => {
    const wrapper = mountFilters('services' as TableKey);
    await addFilter(wrapper, 'default_duration_minutes');

    await wrapper.get(`input[placeholder="${es.generic.minPlaceholder}"]`).setValue('10');
    await wrapper.get(`input[placeholder="${es.generic.maxPlaceholder}"]`).setValue('60');
    await wrapper.get('input[type="checkbox"]').setValue(true);

    expect(lastChange(wrapper)).toEqual({ default_duration_minutes: '!10,60' });
  });

  it('omits the field entirely when both bounds are blank', async () => {
    const wrapper = mountFilters('services' as TableKey);
    await addFilter(wrapper, 'default_duration_minutes');
    // Toggling exclude alone, with both bounds still blank, must not emit a bare "!,".
    await wrapper.get('input[type="checkbox"]').setValue(true);
    expect(lastChange(wrapper)).toEqual({});
  });
});

describe('GenericFilters — enum select', () => {
  it('serializes the chosen option value for a column with options', async () => {
    const wrapper = mountFilters('users' as TableKey);
    await addFilter(wrapper, 'role');

    const selects = wrapper.findAll('select');
    // [0] is the column picker; the per-filter enum select is the next one rendered.
    const roleSelect = selects[1];
    await roleSelect.setValue('Client');

    expect(lastChange(wrapper)).toEqual({ role: 'Client' });
    expect(roleSelect.text()).toContain('Cliente');
  });
});

describe('GenericFilters — remove filter', () => {
  it('removing a filter drops it from both the UI and the serialized payload', async () => {
    const wrapper = mountFilters('services' as TableKey);
    await addFilter(wrapper, 'name');
    await wrapper.get(`input[placeholder="${es.generic.filterPlaceholder}"]`).setValue('corte');
    expect(lastChange(wrapper)).toEqual({ name: 'corte' });

    const removeButton = wrapper.findAll('button').find((b) => b.text() === '✕');
    expect(removeButton).toBeTruthy();
    await removeButton!.trigger('click');

    expect(lastChange(wrapper)).toEqual({});
    expect(wrapper.find(`input[placeholder="${es.generic.filterPlaceholder}"]`).exists()).toBe(false);
    // The column becomes selectable again.
    const nameOption = wrapper.findAll('option').find((o) => o.text() === 'Nombre');
    expect(nameOption?.attributes('disabled')).toBeUndefined();
  });
});

describe('GenericFilters — multiple active filters serialize together', () => {
  it('two filters on the same table both appear in the emitted payload', async () => {
    const wrapper = mountFilters('services' as TableKey);
    await addFilter(wrapper, 'name');
    await wrapper.get(`input[placeholder="${es.generic.filterPlaceholder}"]`).setValue('corte');

    await addFilter(wrapper, 'default_duration_minutes');
    await wrapper.get(`input[placeholder="${es.generic.minPlaceholder}"]`).setValue('15');

    expect(lastChange(wrapper)).toEqual({ name: 'corte', default_duration_minutes: '15,' });
  });
});

describe('GenericFilters — SSOT-driven column set', () => {
  it('only lists filterable columns as addable', () => {
    const wrapper = mountFilters('services' as TableKey);
    const cols = structure.tables.services.columns as Record<string, { filterable?: boolean; label?: { es: string } }>;
    const filterableLabels = Object.values(cols).filter((c) => c.filterable).map((c) => c.label?.es);
    const options = wrapper.findAll('option').map((o) => o.text()).filter((t) => t !== es.generic.addFilterPlaceholder);
    for (const label of filterableLabels) {
      expect(options).toContain(label);
    }
  });
});
