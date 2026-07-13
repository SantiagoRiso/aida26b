import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import ExceptionForm from '@/components/calendar/ExceptionForm.vue';
import TimeField from '@/components/shared/TimeField.vue';
import { createRow } from '@/api/crud';

vi.mock('@/api/crud', () => ({
  createRow: vi.fn().mockResolvedValue({ ok: true, data: {} }),
}));

// Blocking time off previews its turno-conflict count before saving; default to none so these
// body-construction tests proceed straight to createRow. The confirm flow is covered separately.
vi.mock('@/api/scheduling', () => ({
  previewTimeOffConflicts: vi.fn().mockResolvedValue({ ok: true, data: { count: 0 } }),
}));

function makeI18n() {
  return createI18n({ legacy: false, locale: 'es', messages: { es, en } });
}

function mountForm(props: Partial<InstanceType<typeof ExceptionForm>['$props']> = {}) {
  return mount(ExceptionForm, {
    props: { prefillDate: '2026-07-15', professionalId: 10, resourceId: null, ...props },
    global: { plugins: [makeI18n()] },
  });
}

// Start/end use the shared 24h TimeField (VueDatePicker), driven via its model like DateField.
async function setTimes(wrapper: ReturnType<typeof mountForm>, start: string, end: string) {
  const fields = wrapper.findAllComponents(TimeField);
  fields[0].vm.$emit('update:modelValue', start);
  fields[1].vm.$emit('update:modelValue', end);
  await flushPromises();
}

describe('ExceptionForm', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(createRow).mockClear();
  });

  it('submits a full-day off body (default kind) with the prefilled owner and date', async () => {
    const wrapper = mountForm();
    await wrapper.get('#exc-reason').setValue('Vacaciones');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(createRow).toHaveBeenCalledWith('schedule_exceptions', {
      professional_user_id: '10',
      resource_id: null,
      exception_date: '2026-07-15',
      is_unavailable: true,
      start_time: null,
      end_time: null,
      granularity_minutes: null,
      reason: 'Vacaciones',
    });
    expect(wrapper.emitted('saved')).toBeTruthy();
  });

  it('submits a partial-unavailable body with start/end set and granularity null', async () => {
    const wrapper = mountForm();
    await wrapper.get('#exc-kind').setValue('block');
    await setTimes(wrapper, '09:00', '12:00');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(createRow).toHaveBeenCalledWith('schedule_exceptions', expect.objectContaining({
      is_unavailable: true,
      start_time: '09:00',
      end_time: '12:00',
      granularity_minutes: null,
    }));
  });

  it('submits an extra-hours body with is_unavailable false and a positive granularity', async () => {
    const wrapper = mountForm();
    await wrapper.get('#exc-kind').setValue('extra');
    await setTimes(wrapper, '18:00', '20:00');
    await wrapper.get('#exc-granularity').setValue('30');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(createRow).toHaveBeenCalledWith('schedule_exceptions', expect.objectContaining({
      is_unavailable: false,
      start_time: '18:00',
      end_time: '20:00',
      granularity_minutes: 30,
    }));
  });

  it('does NOT call createRow for an invalid extra-hours body missing granularity', async () => {
    const wrapper = mountForm();
    await wrapper.get('#exc-kind').setValue('extra');
    await setTimes(wrapper, '18:00', '20:00');
    // granularity left blank
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(createRow).not.toHaveBeenCalled();
    expect(wrapper.emitted('saved')).toBeFalsy();
  });

  it('does NOT call createRow for a partial window with start >= end', async () => {
    const wrapper = mountForm();
    await wrapper.get('#exc-kind').setValue('block');
    await setTimes(wrapper, '12:00', '09:00');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(createRow).not.toHaveBeenCalled();
  });
});
