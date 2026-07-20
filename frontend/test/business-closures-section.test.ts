import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import BusinessClosuresSection from '@/components/settings/BusinessClosuresSection.vue';
import DateField from '@/components/shared/DateField.vue';
import TimeField from '@/components/shared/TimeField.vue';
import { listClosures, createClosure } from '@/api/closures';

vi.mock('@/api/closures', () => ({
  listClosures: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  createClosure: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  updateClosure: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  deleteClosure: vi.fn().mockResolvedValue({ ok: true, data: { id: '1', deleted: true } }),
}));

// The conflict gate previews turno collisions before saving; none here so the add proceeds straight
// to createClosure. The confirm flow itself is covered by the gate's own tests.
vi.mock('@/api/scheduling', () => ({
  previewTimeOffConflicts: vi.fn().mockResolvedValue({ ok: true, data: { count: 0 } }),
}));

const makeI18n = () => createI18n({ legacy: false, locale: 'es', messages: { es, en } });

function mountSection() {
  return mount(BusinessClosuresSection, { global: { plugins: [makeI18n()] } });
}

// The add form's DateField is the one outside any editing row; it's the last DateField rendered.
function setAddDate(wrapper: ReturnType<typeof mountSection>, date: string) {
  const dateFields = wrapper.findAllComponents(DateField);
  dateFields[dateFields.length - 1].vm.$emit('update:modelValue', date);
}

describe('BusinessClosuresSection all-day toggle', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(createClosure).mockClear();
    vi.mocked(listClosures).mockResolvedValue({ ok: true, data: [] });
  });

  it('defaults to all-day: hides the time fields and saves a full-day closure (null times)', async () => {
    const wrapper = mountSection();
    await flushPromises();

    expect(wrapper.get<HTMLInputElement>('[data-testid="closure-add-allday"]').element.checked).toBe(true);
    expect(wrapper.findAllComponents(TimeField).length).toBe(0);

    setAddDate(wrapper, '2026-07-17');
    await wrapper.get('[data-testid="closure-add-submit"]').trigger('click');
    await flushPromises();

    expect(createClosure).toHaveBeenCalledWith({
      exception_date: '2026-07-17',
      start_time: null,
      end_time: null,
      reason: null,
    });
  });

  it('unchecking all-day reveals the from/to fields and saves the entered range', async () => {
    const wrapper = mountSection();
    await flushPromises();

    await wrapper.get('[data-testid="closure-add-allday"]').setValue(false);
    const times = wrapper.findAllComponents(TimeField);
    expect(times.length).toBe(2);

    setAddDate(wrapper, '2026-07-18');
    times[0].vm.$emit('update:modelValue', '09:00');
    times[1].vm.$emit('update:modelValue', '13:00');
    await flushPromises();

    await wrapper.get('[data-testid="closure-add-submit"]').trigger('click');
    await flushPromises();

    expect(createClosure).toHaveBeenCalledWith({
      exception_date: '2026-07-18',
      start_time: '09:00',
      end_time: '13:00',
      reason: null,
    });
  });

  it('blocks a partial-day closure when a time endpoint is missing', async () => {
    const wrapper = mountSection();
    await flushPromises();

    await wrapper.get('[data-testid="closure-add-allday"]').setValue(false);
    setAddDate(wrapper, '2026-07-19');
    wrapper.findAllComponents(TimeField)[0].vm.$emit('update:modelValue', '09:00'); // only "from"
    await flushPromises();

    await wrapper.get('[data-testid="closure-add-submit"]').trigger('click');
    await flushPromises();

    expect(createClosure).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('Completar desde y hasta');
  });
});

describe('BusinessClosuresSection server errors', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(createClosure).mockClear();
    vi.mocked(listClosures).mockResolvedValue({ ok: true, data: [] });
  });

  async function failSaveWith(failure: Record<string, unknown>) {
    vi.mocked(createClosure).mockResolvedValueOnce(failure as Awaited<ReturnType<typeof createClosure>>);
    const wrapper = mountSection();
    await flushPromises();
    setAddDate(wrapper, '2026-07-20');
    await wrapper.get('[data-testid="closure-add-submit"]').trigger('click');
    await flushPromises();
    return wrapper;
  }

  it('shows the interface-language message, never the server prose', async () => {
    const wrapper = await failSaveWith({
      ok: false,
      status: 403,
      code: 'forbidden',
      message: 'Only an Admin may manage business closures',
      detail: { key: 'closuresAdminOnly' },
    });

    expect(wrapper.text()).toContain(es.apiError.closuresAdminOnly);
    expect(wrapper.text()).not.toContain('Only an Admin');
  });

  it('falls back to the error code when the endpoint names no specific cause', async () => {
    const wrapper = await failSaveWith({
      ok: false,
      status: 403,
      code: 'forbidden',
      message: 'Only an Admin may manage business closures',
    });

    expect(wrapper.text()).toContain(es.apiError.code.forbidden);
  });

  it('falls back to what the screen calls a failed save when the code is unknown', async () => {
    const wrapper = await failSaveWith({
      ok: false,
      status: 500,
      code: 'something_new',
      message: 'Boom',
    });

    expect(wrapper.text()).toContain(es.closures.saveFailed);
    expect(wrapper.text()).not.toContain('Boom');
  });
});
