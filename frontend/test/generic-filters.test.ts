import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { structure } from '@shared/ssot/structure';
import type { TableKey } from '@shared/ssot/derived';
import { listRows } from '@/api/crud';
import { resetFkOptionsCache } from '@/composables/useForeignKeyOptions';
import GenericFilters from '@/components/generic/GenericFilters.vue';

vi.mock('@/api/crud', () => ({ listRows: vi.fn().mockResolvedValue({ ok: true, data: [] }) }));

// GenericFilters needs no auth/router: Pinia backs useLabel() (SSOT column labels follow
// ui.language), and vue-i18n backs the chrome strings (Agregar, excluir, mín/máx…).
function mountFilters(tableKey: TableKey) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const i18n = createI18n({ legacy: false, locale: 'es', messages: { es, en } });
  return mount(GenericFilters, { props: { tableKey }, global: { plugins: [pinia, i18n] } });
}

const columnSelect = (wrapper: ReturnType<typeof mountFilters>) =>
  wrapper.get<HTMLSelectElement>(`select[aria-label="${es.generic.selectColumnAria}"]`);

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

// A free-text box on a boolean or date column offers a control the server can only ignore.
describe('GenericFilters — boolean select', () => {
  it('offers yes/no instead of a text box, and serializes the wire value', async () => {
    const wrapper = mountFilters('users' as TableKey);
    await addFilter(wrapper, 'is_active');

    expect(wrapper.find(`input[placeholder="${es.generic.filterPlaceholder}"]`).exists()).toBe(false);

    const activeSelect = wrapper.findAll('select')[1];
    expect(activeSelect.text()).toContain(es.generic.yes);
    expect(activeSelect.text()).toContain(es.generic.no);

    await activeSelect.setValue('false');
    expect(lastChange(wrapper)).toEqual({ is_active: 'false' });

    await wrapper.get('input[type="checkbox"]').setValue(true);
    expect(lastChange(wrapper)).toEqual({ is_active: '!false' });
  });
});

describe('GenericFilters — date range', () => {
  it('offers two date inputs and serializes them as "from,to"', async () => {
    const wrapper = mountFilters('sessions' as TableKey);
    await addFilter(wrapper, 'expires_at');

    expect(wrapper.find(`input[placeholder="${es.generic.filterPlaceholder}"]`).exists()).toBe(false);

    const from = wrapper.get(`input[type="date"][aria-label="${es.generic.from}"]`);
    const to = wrapper.get(`input[type="date"][aria-label="${es.generic.to}"]`);

    await from.setValue('2026-07-01');
    expect(lastChange(wrapper)).toEqual({ expires_at: '2026-07-01,' });

    await to.setValue('2026-07-31');
    expect(lastChange(wrapper)).toEqual({ expires_at: '2026-07-01,2026-07-31' });
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

describe('GenericFilters — foreign key column', () => {
  beforeEach(() => {
    resetFkOptionsCache();
    (listRows as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: [{ id: 'biz-1', name: 'Clínica Central' }],
    });
  });

  it('offers the referenced rows by name instead of free text on an id', async () => {
    const wrapper = mountFilters('users' as TableKey);
    await addFilter(wrapper, 'business_id');
    await flushPromises();

    // The backend matches a referenced id exactly, so this column never gets a text box.
    expect(wrapper.find(`input[placeholder="${es.generic.filterPlaceholder}"]`).exists()).toBe(false);

    const picker = wrapper.get(`input[placeholder="${es.generic.all}"]`);
    await picker.setValue('clínica');
    const rendered = wrapper.findAll('[role=option]').map((o) => o.text());
    expect(rendered.some((t) => t.includes('Clínica Central'))).toBe(true);
  });

  it('serializes the chosen id, and the exclude prefix still applies to it', async () => {
    const wrapper = mountFilters('users' as TableKey);
    await addFilter(wrapper, 'business_id');
    await flushPromises();

    const picker = wrapper.get(`input[placeholder="${es.generic.all}"]`);
    await picker.setValue('clínica');
    await picker.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(lastChange(wrapper)).toEqual({ business_id: 'biz-1' });

    await wrapper.get('input[type="checkbox"]').setValue(true);
    expect(lastChange(wrapper)).toEqual({ business_id: '!biz-1' });
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
