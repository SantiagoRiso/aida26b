import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { listRows, createRow, updateRow, deleteRow } from '@/api/crud';
import ProfessionalServicesSection from '@/components/settings/ProfessionalServicesSection.vue';

vi.mock('@/api/crud', () => ({
  listRows: vi.fn(),
  createRow: vi.fn(),
  updateRow: vi.fn(),
  deleteRow: vi.fn(),
}));

const makeI18n = () => createI18n({ legacy: false, locale: 'es', messages: { es, en } });

const SERVICES = [
  { id: '1', business_id: 'b1', name: 'Corte', description: null, default_duration_minutes: 30, default_price_ars: '1000.00' },
  { id: '2', business_id: 'b1', name: 'Color', description: null, default_duration_minutes: 90, default_price_ars: '5000.00' },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockCrud(offerings: any[]) {
  vi.mocked(listRows).mockImplementation(async (table: string) => {
    if (table === 'services') return { ok: true, data: SERVICES } as never;
    if (table === 'professional_services') return { ok: true, data: offerings } as never;
    return { ok: true, data: [] } as never;
  });
}

function mountSection(professionalUserId: number | null = 7) {
  return mount(ProfessionalServicesSection, {
    props: { professionalUserId },
    global: { plugins: [makeI18n()] },
  });
}

describe('ProfessionalServicesSection', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('shows a hint and no checklist when no professional is selected', async () => {
    mockCrud([]);
    const w = mountSection(null);
    await flushPromises();
    expect(w.text()).toContain('Seleccionar un profesional');
    expect(w.find('[data-testid="offering-toggle-1"]').exists()).toBe(false);
  });

  it('renders every service and checks the ones already offered', async () => {
    mockCrud([{ id: 'ps-1', professional_user_id: '7', service_id: '1', min_booking_days: null, max_booking_days: null }]);
    const w = mountSection();
    await flushPromises();
    expect(listRows).toHaveBeenCalledWith('services', { limit: 500 });
    expect(listRows).toHaveBeenCalledWith('professional_services', { filters: { professional_user_id: '7' }, limit: 200 });
    expect(w.get<HTMLInputElement>('[data-testid="offering-toggle-1"]').element.checked).toBe(true);
    expect(w.get<HTMLInputElement>('[data-testid="offering-toggle-2"]').element.checked).toBe(false);
  });

  it('shows a hint when the business has no services yet', async () => {
    vi.mocked(listRows).mockImplementation(async (table: string) => {
      if (table === 'services') return { ok: true, data: [] } as never;
      return { ok: true, data: [] } as never;
    });
    const w = mountSection();
    await flushPromises();
    expect(w.text()).toContain('Primero agregá servicios');
  });

  it('creates an offering when a service is ticked', async () => {
    mockCrud([]);
    vi.mocked(createRow).mockResolvedValue({ ok: true, data: { id: 'ps-9', professional_user_id: '7', service_id: '2', min_booking_days: null, max_booking_days: null } } as never);
    const w = mountSection();
    await flushPromises();
    await w.get('[data-testid="offering-toggle-2"]').setValue(true);
    await flushPromises();
    // Generic creates are full-object — the nullable window columns must be present (as null).
    expect(createRow).toHaveBeenCalledWith('professional_services', {
      professional_user_id: '7',
      service_id: '2',
      min_booking_days: null,
      max_booking_days: null,
    });
    expect(w.get<HTMLInputElement>('[data-testid="offering-toggle-2"]').element.checked).toBe(true);
  });

  it('deletes the offering when a service is unticked', async () => {
    mockCrud([{ id: 'ps-1', professional_user_id: '7', service_id: '1', min_booking_days: null, max_booking_days: null }]);
    vi.mocked(deleteRow).mockResolvedValue({ ok: true, data: { id: 'ps-1' } } as never);
    const w = mountSection();
    await flushPromises();
    await w.get('[data-testid="offering-toggle-1"]').setValue(false);
    await flushPromises();
    expect(deleteRow).toHaveBeenCalledWith('professional_services', 'ps-1');
    expect(w.get<HTMLInputElement>('[data-testid="offering-toggle-1"]').element.checked).toBe(false);
  });

  it('reverts the checkbox when the create fails', async () => {
    mockCrud([]);
    vi.mocked(createRow).mockResolvedValue({ ok: false, message: 'nope' } as never);
    const w = mountSection();
    await flushPromises();
    await w.get('[data-testid="offering-toggle-2"]').setValue(true);
    await flushPromises();
    expect(w.get<HTMLInputElement>('[data-testid="offering-toggle-2"]').element.checked).toBe(false);
  });

  it('saves a custom booking window via updateRow', async () => {
    mockCrud([{ id: 'ps-1', professional_user_id: '7', service_id: '1', min_booking_days: null, max_booking_days: null }]);
    vi.mocked(updateRow).mockResolvedValue({ ok: true, data: { id: 'ps-1', professional_user_id: '7', service_id: '1', min_booking_days: 2, max_booking_days: 20 } } as never);
    const w = mountSection();
    await flushPromises();
    await w.get('[data-testid="offering-window-edit-1"]').trigger('click');
    await w.get('[data-testid="offering-min-1"]').setValue('2');
    await w.get('[data-testid="offering-max-1"]').setValue('20');
    await w.get('[data-testid="offering-window-save-1"]').trigger('click');
    await flushPromises();
    expect(updateRow).toHaveBeenCalledWith('professional_services', 'ps-1', { min_booking_days: 2, max_booking_days: 20 });
  });

  it('clears the window (inherit business default) via updateRow with nulls', async () => {
    mockCrud([{ id: 'ps-1', professional_user_id: '7', service_id: '1', min_booking_days: 2, max_booking_days: 20 }]);
    vi.mocked(updateRow).mockResolvedValue({ ok: true, data: { id: 'ps-1', professional_user_id: '7', service_id: '1', min_booking_days: null, max_booking_days: null } } as never);
    const w = mountSection();
    await flushPromises();
    await w.get('[data-testid="offering-window-edit-1"]').trigger('click');
    await w.get('[data-testid="offering-window-default-1"]').trigger('click');
    await flushPromises();
    expect(updateRow).toHaveBeenCalledWith('professional_services', 'ps-1', { min_booking_days: null, max_booking_days: null });
  });

  it('blocks the window save when max < min', async () => {
    mockCrud([{ id: 'ps-1', professional_user_id: '7', service_id: '1', min_booking_days: null, max_booking_days: null }]);
    const w = mountSection();
    await flushPromises();
    await w.get('[data-testid="offering-window-edit-1"]').trigger('click');
    await w.get('[data-testid="offering-min-1"]').setValue('10');
    await w.get('[data-testid="offering-max-1"]').setValue('5');
    await w.get('[data-testid="offering-window-save-1"]').trigger('click');
    await flushPromises();
    expect(updateRow).not.toHaveBeenCalled();
    expect(w.text()).toContain('mayor o igual');
  });
});
