import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { listRows, createRow, updateRow } from '@/api/crud';
import { useAuthStore } from '@/stores/auth';
import type { Role } from '@shared/types/roles';
import type { TableRecordMap } from '@shared/ssot/derived';
import type { Wire } from '@shared/ssot/query-types';
import ClientPricesSection from '@/components/staff/ClientPricesSection.vue';
import Selector from '@/components/shared/Selector.vue';
import { listRowsFrom, rowResultFrom } from './helpers/api-fixtures';

vi.mock('@/api/crud', () => ({
  listRows: vi.fn(),
  createRow: vi.fn(),
  updateRow: vi.fn(),
}));

const CLIENT_ID = 3;

const PROFESSIONALS = [
  { id: '10', display_name: 'Ana', bio: null },
  { id: '11', display_name: 'Beto', bio: null },
];
const SERVICES = [
  { id: '1', business_id: 'b1', name: 'Corte', description: null, default_duration_minutes: 30, default_price_ars: '1000.00' },
  { id: '2', business_id: 'b1', name: 'Color', description: null, default_duration_minutes: 90, default_price_ars: '5000.00' },
];
// Ana (10) offers both services; Beto (11) offers only Color (2).
const PROF_SERVICES = [
  { id: 'ps-1', professional_user_id: '10', service_id: '1', min_booking_days: null, max_booking_days: null },
  { id: 'ps-2', professional_user_id: '10', service_id: '2', min_booking_days: null, max_booking_days: null },
  { id: 'ps-3', professional_user_id: '11', service_id: '2', min_booking_days: null, max_booking_days: null },
];

type Override = Wire<TableRecordMap['client_professional_services']>;

// Selector is a generic SFC, so findAllComponents infers a bare DOMWrapper; this is the slice of
// the picker wrapper the assertions actually touch.
interface PickerWrapper {
  props(name: 'options'): { value: string }[];
  vm: { $emit(event: string, value: string): void };
}

// findAllComponents on a generic SFC infers DOMWrapper (no props/vm); bridge through object[] so the
// narrowing to the picker slice stays type-checked without the banned `unknown` keyword.
function pickers(w: ReturnType<typeof mountAs>): PickerWrapper[] {
  return w.findAllComponents(Selector) as object[] as PickerWrapper[];
}

function mockCrud(overrides: Override[]) {
  vi.mocked(listRows).mockImplementation(
    listRowsFrom({
      professionals: PROFESSIONALS,
      services: SERVICES,
      professional_services: PROF_SERVICES,
      client_professional_services: overrides,
    }),
  );
}

function makeI18n() {
  return createI18n({ legacy: false, locale: 'es', messages: { es, en } });
}

// DetailPanel wraps its content in a Headless UI dialog that renders empty under jsdom; stub the
// chrome to a plain slot so the add/edit form reaches the DOM.
const DetailPanelStub = {
  name: 'DetailPanel',
  props: ['open', 'title'],
  template: '<div v-if="open"><slot /></div>',
};

function mountAs(role: Role, overrides: Override[] = []) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore();
  auth.user = {
    id: 99,
    username: 'staff',
    email: 'staff@demo.test',
    role,
    business_id: 1,
    is_active: true,
    must_change_password: false,
  };
  mockCrud(overrides);
  return mount(ClientPricesSection, {
    props: { clientId: CLIENT_ID },
    global: { plugins: [pinia, makeI18n()], stubs: { DetailPanel: DetailPanelStub } },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ClientPricesSection', () => {
  it('lists the client\'s per-professional-per-service overrides with resolved names and formatted price', async () => {
    const w = mountAs('Admin', [
      { id: 'cps-1', client_user_id: String(CLIENT_ID), professional_user_id: '10', service_id: '2', price_ars: '4200.00' },
    ]);
    await flushPromises();

    // Scoped to this client.
    expect(listRows).toHaveBeenCalledWith('client_professional_services', {
      filters: { client_user_id: '3' },
      limit: 200,
    });

    const row = w.get('[data-testid="client-price-row-cps-1"]');
    expect(row.text()).toContain('Ana');
    expect(row.text()).toContain('Color');
    // ARS money, formatted es-AR.
    expect(row.text()).toContain('4.200,00');
  });

  it('shows an empty state when the client has no overrides', async () => {
    const w = mountAs('Admin', []);
    await flushPromises();
    expect(w.text()).toContain(es.clientPrices.emptyHeading);
  });

  it('opens the add form with FK selectors (not raw id inputs) for professional and service', async () => {
    const w = mountAs('Admin', []);
    await flushPromises();

    await w.get('[data-testid="client-prices-add"]').trigger('click');
    await flushPromises();

    // Two FK pickers (professional, service) rendered as the shared Selector — chosen from a list,
    // not typed as raw numeric ids.
    const selectors = pickers(w);
    expect(selectors.length).toBe(2);
    expect(selectors[0].props('options')).toBeInstanceOf(Array);
    expect(selectors[1].props('options')).toBeInstanceOf(Array);
    // No raw-id number input anywhere; the money field is the only free-text field of the form.
    expect(w.findAll('input[type="number"]').length).toBe(0);
    expect(w.get('#client-price-amount').attributes('type')).toBe('text');
  });

  it('narrows the service options to what the chosen professional offers', async () => {
    const w = mountAs('Admin', []);
    await flushPromises();
    await w.get('[data-testid="client-prices-add"]').trigger('click');
    await flushPromises();

    const [prof, service] = pickers(w);
    // Beto (11) offers only Color (2).
    prof.vm.$emit('update:modelValue', '11');
    await flushPromises();

    const options = service.props('options');
    expect(options.map((o) => o.value)).toEqual(['2']);
  });

  it('submits price_ars as a string via createRow', async () => {
    const w = mountAs('Admin', []);
    await flushPromises();
    await w.get('[data-testid="client-prices-add"]').trigger('click');
    await flushPromises();

    vi.mocked(createRow).mockImplementation(
      rowResultFrom({
        client_professional_services: [
          { id: 'cps-9', client_user_id: '3', professional_user_id: '10', service_id: '1', price_ars: '1500.50' },
        ],
      }),
    );

    const [prof, service] = pickers(w);
    prof.vm.$emit('update:modelValue', '10');
    await flushPromises();
    service.vm.$emit('update:modelValue', '1');
    await w.get('#client-price-amount').setValue('1500.50');
    await w.get('form').trigger('submit');
    await flushPromises();

    expect(createRow).toHaveBeenCalledWith('client_professional_services', {
      client_user_id: '3',
      professional_user_id: '10',
      service_id: '1',
      price_ars: '1500.50',
    });
  });

  it('surfaces the SSoT money-format error on a bad price and does not submit', async () => {
    const w = mountAs('Admin', []);
    await flushPromises();
    await w.get('[data-testid="client-prices-add"]').trigger('click');
    await flushPromises();

    const [prof, service] = pickers(w);
    prof.vm.$emit('update:modelValue', '10');
    await flushPromises();
    service.vm.$emit('update:modelValue', '1');
    await w.get('#client-price-amount').setValue('abc');
    await w.get('form').trigger('submit');
    await flushPromises();

    expect(createRow).not.toHaveBeenCalled();
    expect(w.text()).toContain(es.fieldError.amountFormat);
  });

  it('edits an existing override via updateRow, sending the price string', async () => {
    const w = mountAs('Admin', [
      { id: 'cps-1', client_user_id: '3', professional_user_id: '10', service_id: '1', price_ars: '900.00' },
    ]);
    await flushPromises();

    vi.mocked(updateRow).mockImplementation(
      rowResultFrom({
        client_professional_services: [
          { id: 'cps-1', client_user_id: '3', professional_user_id: '10', service_id: '1', price_ars: '950.00' },
        ],
      }),
    );

    await w.get('[data-testid="client-price-edit-cps-1"]').trigger('click');
    await flushPromises();
    await w.get('#client-price-amount').setValue('950.00');
    await w.get('form').trigger('submit');
    await flushPromises();

    expect(updateRow).toHaveBeenCalledWith('client_professional_services', 'cps-1', {
      client_user_id: '3',
      professional_user_id: '10',
      service_id: '1',
      price_ars: '950.00',
    });
  });

  it('hides the section from a role without create/update (Professional)', async () => {
    const w = mountAs('Professional', [
      { id: 'cps-1', client_user_id: '3', professional_user_id: '10', service_id: '1', price_ars: '900.00' },
    ]);
    await flushPromises();
    expect(w.find('[data-testid="client-prices-section"]').exists()).toBe(false);
  });

  it('shows the section to a role with create/update (Receptionist)', async () => {
    const w = mountAs('Receptionist', []);
    await flushPromises();
    expect(w.find('[data-testid="client-prices-section"]').exists()).toBe(true);
    expect(w.find('[data-testid="client-prices-add"]').exists()).toBe(true);
  });
});
