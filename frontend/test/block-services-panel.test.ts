import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { useUiStore } from '@/stores/ui';
import { listRows, createRow, updateRow, deleteRow } from '@/api/crud';
import type { ListParams } from '@/api/crud';
import BlockServicesPanel from '@/components/schedule/BlockServicesPanel.vue';

vi.mock('@/api/crud', () => ({
  listRows: vi.fn(),
  createRow: vi.fn(),
  updateRow: vi.fn(),
  deleteRow: vi.fn(),
}));

const block = {
  id: 'blk-1',
  professional_user_id: '7',
  weekday: 'mon' as const,
  start_time: '09:00',
  end_time: '12:00',
};

const blockB = {
  id: 'blk-2',
  professional_user_id: '7',
  weekday: 'tue' as const,
  start_time: '13:00',
  end_time: '17:00',
};

const makeI18n = () => createI18n({ legacy: false, locale: 'es', messages: { es, en } });

function mockListRows() {
  vi.mocked(listRows).mockImplementation(async (table: string) => {
    if (table === 'professional_services') {
      return {
        ok: true,
        data: [
          { id: 'ps-1', professional_user_id: '7', service_id: '1', min_booking_days: null, max_booking_days: null },
          { id: 'ps-2', professional_user_id: '7', service_id: '2', min_booking_days: null, max_booking_days: null },
        ],
      };
    }
    if (table === 'services') {
      return {
        ok: true,
        data: [
          { id: '1', business_id: 'b1', name: 'Corte', description: null, default_duration_minutes: 30, default_price_ars: '1000.00' },
          { id: '2', business_id: 'b1', name: 'Color', description: null, default_duration_minutes: 90, default_price_ars: '5000.00' },
        ],
      };
    }
    if (table === 'schedule_block_services') {
      return {
        ok: true,
        data: [
          { id: 'sbs-1', professional_user_id: '7', schedule_block_id: 'blk-1', service_id: '1', duration_minutes: 45, price_ars: '1500.00' },
        ],
      };
    }
    return { ok: true, data: [] };
  });
}

function mockListRowsPerBlock() {
  vi.mocked(listRows).mockImplementation(async (table: string, opts?: ListParams) => {
    if (table === 'professional_services') {
      return {
        ok: true,
        data: [
          { id: 'ps-1', professional_user_id: '7', service_id: '1', min_booking_days: null, max_booking_days: null },
          { id: 'ps-2', professional_user_id: '7', service_id: '2', min_booking_days: null, max_booking_days: null },
        ],
      };
    }
    if (table === 'services') {
      return {
        ok: true,
        data: [
          { id: '1', business_id: 'b1', name: 'Corte', description: null, default_duration_minutes: 30, default_price_ars: '1000.00' },
          { id: '2', business_id: 'b1', name: 'Color', description: null, default_duration_minutes: 90, default_price_ars: '5000.00' },
        ],
      };
    }
    if (table === 'schedule_block_services') {
      const blockId = opts?.filters?.schedule_block_id;
      if (blockId === 'blk-1') {
        return {
          ok: true,
          data: [
            { id: 'sbs-1', professional_user_id: '7', schedule_block_id: 'blk-1', service_id: '1', duration_minutes: 45, price_ars: '1500.00' },
          ],
        };
      }
      if (blockId === 'blk-2') {
        return {
          ok: true,
          data: [
            { id: 'sbs-2', professional_user_id: '7', schedule_block_id: 'blk-2', service_id: '2', duration_minutes: 90, price_ars: '5000.00' },
          ],
        };
      }
      return { ok: true, data: [] };
    }
    return { ok: true, data: [] };
  });
}

// block A is 09:00-12:00 = 180 min by default; callers pass a length that (in)divides a service
// duration to exercise the slot-fit warning.
async function mountPanel(blockMinutes = 180) {
  const wrapper = mount(BlockServicesPanel, {
    props: { block, blockMinutes },
    global: { plugins: [makeI18n()] },
  });
  await flushPromises();
  return wrapper;
}

function panelVm(wrapper: Awaited<ReturnType<typeof mountPanel>>) {
  return wrapper.vm as typeof wrapper.vm & { save(): Promise<boolean> };
}

describe('BlockServicesPanel', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockListRows();
  });

  it('renders both bound services, showing the already-offered one as enabled with its overrides', async () => {
    const wrapper = await mountPanel();

    expect(listRows).toHaveBeenCalledWith('professional_services', { filters: { professional_user_id: '7' }, limit: 200 });
    expect(listRows).toHaveBeenCalledWith('services', { limit: 500 });
    expect(listRows).toHaveBeenCalledWith('schedule_block_services', { filters: { schedule_block_id: 'blk-1' }, limit: 200 });

    expect(wrapper.text()).toContain('Corte');
    expect(wrapper.text()).toContain('Color');

    const toggle1 = wrapper.get<HTMLInputElement>('[data-testid="block-service-toggle-1"]');
    const toggle2 = wrapper.get<HTMLInputElement>('[data-testid="block-service-toggle-2"]');
    expect(toggle1.element.checked).toBe(true);
    expect(toggle2.element.checked).toBe(false);

    const duration1 = wrapper.get<HTMLInputElement>('[data-testid="block-service-duration-1"]');
    const price1 = wrapper.get<HTMLInputElement>('[data-testid="block-service-price-1"]');
    expect(duration1.element.value).toBe('45');
    expect(price1.element.value).toBe('1500.00');

    expect(wrapper.find('[data-testid="block-service-duration-2"]').exists()).toBe(false);
  });

  it('enables a not-yet-offered service by creating a schedule_block_services row', async () => {
    vi.mocked(createRow).mockResolvedValueOnce({
      ok: true,
      data: { id: 'sbs-2', professional_user_id: '7', schedule_block_id: 'blk-1', service_id: '2', duration_minutes: null, price_ars: null },
    });
    const wrapper = await mountPanel();

    await wrapper.get('[data-testid="block-service-toggle-2"]').setValue(true);
    expect(createRow).not.toHaveBeenCalled(); // local until submit
    await panelVm(wrapper).save();
    await flushPromises();

    expect(createRow).toHaveBeenCalledWith('schedule_block_services', {
      professional_user_id: '7',
      schedule_block_id: 'blk-1',
      service_id: '2',
      duration_minutes: null,
      price_ars: null,
    });
    const toggle2 = wrapper.get<HTMLInputElement>('[data-testid="block-service-toggle-2"]');
    expect(toggle2.element.checked).toBe(true);
  });

  it('saves a duration override via updateRow', async () => {
    vi.mocked(updateRow).mockResolvedValueOnce({
      ok: true,
      data: { id: 'sbs-1', professional_user_id: '7', schedule_block_id: 'blk-1', service_id: '1', duration_minutes: 60, price_ars: '1500.00' },
    });
    const wrapper = await mountPanel();

    const duration1 = wrapper.get('[data-testid="block-service-duration-1"]');
    await duration1.setValue('60');
    expect(updateRow).not.toHaveBeenCalled(); // local until submit
    await panelVm(wrapper).save();
    await flushPromises();

    expect(updateRow).toHaveBeenCalledWith('schedule_block_services', 'sbs-1', {
      professional_user_id: '7',
      schedule_block_id: 'blk-1',
      service_id: '1',
      duration_minutes: 60,
      price_ars: '1500.00',
    });
  });

  it('disables an offered service by deleting its schedule_block_services row', async () => {
    vi.mocked(deleteRow).mockResolvedValueOnce({
      ok: true,
      data: { id: 'sbs-1', professional_user_id: '7', schedule_block_id: 'blk-1', service_id: '1', duration_minutes: 45, price_ars: '1500.00' },
    });
    const wrapper = await mountPanel();

    await wrapper.get('[data-testid="block-service-toggle-1"]').setValue(false);
    expect(deleteRow).not.toHaveBeenCalled(); // local until submit
    await panelVm(wrapper).save();
    await flushPromises();

    expect(deleteRow).toHaveBeenCalledWith('schedule_block_services', 'sbs-1');
    const toggle1 = wrapper.get<HTMLInputElement>('[data-testid="block-service-toggle-1"]');
    expect(toggle1.element.checked).toBe(false);
    expect(wrapper.find('[data-testid="block-service-duration-1"]').exists()).toBe(false);
  });

  it('warns when the offered service duration does not divide the block length', async () => {
    // Service 1 is offered with a 45-min override; a 100-min block leaves 100 % 45 = 10 unbookable min.
    const wrapper = await mountPanel(100);
    const warning = wrapper.find('[data-testid="block-service-warning-1"]');
    expect(warning.exists()).toBe(true);
    expect(warning.text()).toContain('45');
    expect(warning.text()).toContain('10');
    // The non-offered service shows no warning (only offered services generate slots).
    expect(wrapper.find('[data-testid="block-service-warning-2"]').exists()).toBe(false);
  });

  it('shows no warning when the duration divides the block length evenly', async () => {
    // 90 % 45 = 0 → clean fit, no leftover minutes.
    const wrapper = await mountPanel(90);
    expect(wrapper.find('[data-testid="block-service-warning-1"]').exists()).toBe(false);
  });

  it('prefills inherited duration/price as disabled defaults; pinning "independent" writes the defaults', async () => {
    // Service 1 offered but inheriting the service default (null overrides).
    vi.mocked(listRows).mockImplementation(async (table: string) => {
      if (table === 'professional_services') {
        return { ok: true, data: [{ id: 'ps-1', professional_user_id: '7', service_id: '1', min_booking_days: null, max_booking_days: null }] };
      }
      if (table === 'services') {
        return { ok: true, data: [{ id: '1', business_id: 'b1', name: 'Corte', description: null, default_duration_minutes: 30, default_price_ars: '1000.00' }] };
      }
      if (table === 'schedule_block_services') {
        return { ok: true, data: [{ id: 'sbs-1', professional_user_id: '7', schedule_block_id: 'blk-1', service_id: '1', duration_minutes: null, price_ars: null }] };
      }
      return { ok: true, data: [] };
    });
    const wrapper = await mountPanel();

    const dur = wrapper.get<HTMLInputElement>('[data-testid="block-service-duration-1"]');
    const price = wrapper.get<HTMLInputElement>('[data-testid="block-service-price-1"]');
    const indep = wrapper.get<HTMLInputElement>('[data-testid="block-service-independent-1"]');
    // Disabled by default, prefilled with the service defaults.
    expect(indep.element.checked).toBe(false);
    expect(dur.element.disabled).toBe(true);
    expect(dur.element.value).toBe('30');
    expect(price.element.value).toBe('1000.00');

    vi.mocked(updateRow).mockResolvedValueOnce({
      ok: true,
      data: { id: 'sbs-1', professional_user_id: '7', schedule_block_id: 'blk-1', service_id: '1', duration_minutes: 30, price_ars: '1000.00' },
    });
    await indep.setValue(true);
    await flushPromises();
    // Editable immediately (local); persisted only on save().
    expect(wrapper.get<HTMLInputElement>('[data-testid="block-service-duration-1"]').element.disabled).toBe(false);
    expect(updateRow).not.toHaveBeenCalled();
    await panelVm(wrapper).save();
    await flushPromises();

    // The current defaults are pinned as the block's own values.
    expect(updateRow).toHaveBeenCalledWith('schedule_block_services', 'sbs-1', {
      professional_user_id: '7', schedule_block_id: 'blk-1', service_id: '1', duration_minutes: 30, price_ars: '1000.00',
    });
  });

  it('unpinning "independent" reverts the block to the service defaults', async () => {
    // Default mock: service 1 offered with a 45-min / 1500 override → managed independently.
    const wrapper = await mountPanel();
    const indep = wrapper.get<HTMLInputElement>('[data-testid="block-service-independent-1"]');
    expect(indep.element.checked).toBe(true);

    vi.mocked(updateRow).mockResolvedValueOnce({
      ok: true,
      data: { id: 'sbs-1', professional_user_id: '7', schedule_block_id: 'blk-1', service_id: '1', duration_minutes: null, price_ars: null },
    });
    await indep.setValue(false);
    await flushPromises();
    // Reverts locally at once; the clear-override write happens on save().
    const dur = wrapper.get<HTMLInputElement>('[data-testid="block-service-duration-1"]');
    expect(dur.element.disabled).toBe(true);
    expect(dur.element.value).toBe('30');
    await panelVm(wrapper).save();
    await flushPromises();

    expect(updateRow).toHaveBeenCalledWith('schedule_block_services', 'sbs-1', {
      professional_user_id: '7', schedule_block_id: 'blk-1', service_id: '1', duration_minutes: null, price_ars: null,
    });
  });

  it('labels a single service (no checkbox) and auto-offers it when the block has none', async () => {
    vi.mocked(createRow).mockResolvedValueOnce({
      ok: true,
      data: { id: 'sbs-x', professional_user_id: '7', schedule_block_id: 'blk-1', service_id: '1', duration_minutes: null, price_ars: null },
    });
    vi.mocked(listRows).mockImplementation(async (table: string) => {
      if (table === 'professional_services') {
        return { ok: true, data: [{ id: 'ps-1', professional_user_id: '7', service_id: '1', min_booking_days: null, max_booking_days: null }] };
      }
      if (table === 'services') {
        return { ok: true, data: [{ id: '1', business_id: 'b1', name: 'Corte', description: null, default_duration_minutes: 30, default_price_ars: '1000.00' }] };
      }
      if (table === 'schedule_block_services') return { ok: true, data: [] };
      return { ok: true, data: [] };
    });
    const wrapper = await mountPanel();

    // No offered checkbox — the lone service is labeled and treated as offered locally…
    expect(wrapper.find('[data-testid="block-service-toggle-1"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="block-service-label-1"]').text()).toContain('Corte');
    expect(wrapper.get<HTMLInputElement>('[data-testid="block-service-duration-1"]').element.value).toBe('30');
    expect(createRow).not.toHaveBeenCalled(); // not written until submit
    await panelVm(wrapper).save();
    await flushPromises();

    // …and its offering is created on submit.
    expect(createRow).toHaveBeenCalledWith('schedule_block_services', {
      professional_user_id: '7', schedule_block_id: 'blk-1', service_id: '1', duration_minutes: null, price_ars: null,
    });
  });

  it('does not re-offer a single service that is already offered', async () => {
    vi.mocked(listRows).mockImplementation(async (table: string) => {
      if (table === 'professional_services') {
        return { ok: true, data: [{ id: 'ps-1', professional_user_id: '7', service_id: '1', min_booking_days: null, max_booking_days: null }] };
      }
      if (table === 'services') {
        return { ok: true, data: [{ id: '1', business_id: 'b1', name: 'Corte', description: null, default_duration_minutes: 30, default_price_ars: '1000.00' }] };
      }
      if (table === 'schedule_block_services') {
        return { ok: true, data: [{ id: 'sbs-1', professional_user_id: '7', schedule_block_id: 'blk-1', service_id: '1', duration_minutes: null, price_ars: null }] };
      }
      return { ok: true, data: [] };
    });
    const wrapper = await mountPanel();
    await panelVm(wrapper).save();
    await flushPromises();

    expect(createRow).not.toHaveBeenCalled(); // already offered → nothing to create on submit
    expect(wrapper.find('[data-testid="block-service-toggle-1"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="block-service-label-1"]').text()).toContain('Corte');
  });

  it('renders a per-service field error from a failed save without a generic toast', async () => {
    vi.mocked(updateRow).mockResolvedValueOnce({
      ok: false, status: 422, code: 'validation_error', message: 'invalid',
      fields: { duration_minutes: 'duration_minutes must be >= 1' },
      fieldDetails: { duration_minutes: { key: 'minValue', params: { min: 1 } } },
    });
    const wrapper = await mountPanel();

    const duration1 = wrapper.get('[data-testid="block-service-duration-1"]');
    await duration1.setValue('0');
    const ok = await panelVm(wrapper).save();
    await flushPromises();

    expect(ok).toBe(false);
    expect(wrapper.text()).toContain(es.fieldError.minValue.replace('{min}', '1'));
    expect(wrapper.text()).not.toContain('duration_minutes');
    // A field-level error is surfaced inline, not as a generic toast (recordError only falls back
    // to the toast when the server returns no field errors).
    const ui = useUiStore();
    expect(ui.toasts).toHaveLength(0);
  });

  it('reloads and shows block B rows (not stale block A rows) when the block prop changes', async () => {
    mockListRowsPerBlock();
    const wrapper = mount(BlockServicesPanel, {
      props: { block, blockMinutes: 180 },
      global: { plugins: [makeI18n()] },
    });
    await flushPromises();

    // Sanity check: block A's offering (service 1) is showing before the switch.
    let toggle1 = wrapper.get<HTMLInputElement>('[data-testid="block-service-toggle-1"]');
    expect(toggle1.element.checked).toBe(true);
    expect(wrapper.find('[data-testid="block-service-toggle-2"]').exists() ? wrapper.get<HTMLInputElement>('[data-testid="block-service-toggle-2"]').element.checked : false).toBe(false);

    await wrapper.setProps({ block: blockB });
    await flushPromises();

    expect(listRows).toHaveBeenCalledWith('schedule_block_services', { filters: { schedule_block_id: 'blk-2' }, limit: 200 });

    // Block B offers service 2, not service 1 — rows must reflect B only, no leftover A state.
    const toggle2 = wrapper.get<HTMLInputElement>('[data-testid="block-service-toggle-2"]');
    expect(toggle2.element.checked).toBe(true);
    toggle1 = wrapper.get<HTMLInputElement>('[data-testid="block-service-toggle-1"]');
    expect(toggle1.element.checked).toBe(false);

    const duration2 = wrapper.get<HTMLInputElement>('[data-testid="block-service-duration-2"]');
    expect(duration2.element.value).toBe('90');
    expect(wrapper.find('[data-testid="block-service-duration-1"]').exists()).toBe(false);
  });
});
