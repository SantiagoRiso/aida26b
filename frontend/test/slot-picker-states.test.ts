import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { getAvailability } from '@/api/scheduling';
import SlotPicker from '@/components/calendar/SlotPicker.vue';

vi.mock('@/api/scheduling', () => ({
  getAvailability: vi.fn(),
}));

const makeI18n = () => createI18n({ legacy: false, locale: 'es', messages: { es, en } });

function mountPicker(props: {
  professionalId: number | null;
  serviceId: number | null;
  date: string | null;
  modelValue: string | null;
}) {
  return mount(SlotPicker, { props, global: { plugins: [makeI18n()] } });
}

describe('SlotPicker', () => {
  beforeEach(() => {
    vi.mocked(getAvailability).mockReset();
  });

  it('shows the prompt when no professional or date is chosen yet', async () => {
    const wrapper = mountPicker({ professionalId: null, serviceId: null, date: null, modelValue: null });
    await flushPromises();

    expect(wrapper.text()).toContain(es.calendar.slotPickerPrompt);
    expect(getAvailability).not.toHaveBeenCalled();
  });

  it('shows a loading state while the availability request is in flight', async () => {
    // Default resolution backs the neighbour-day prefetch calls; the explicit Once below delays
    // only the main (current-date) fetch that the loading state depends on.
    vi.mocked(getAvailability).mockResolvedValue({
      ok: true, data: { date: '2026-08-25', slots: [], open: true, outside_window: false },
    });
    let resolve!: (value: Awaited<ReturnType<typeof getAvailability>>) => void;
    vi.mocked(getAvailability).mockReturnValueOnce(new Promise((r) => { resolve = r; }));

    const wrapper = mountPicker({ professionalId: 1, serviceId: 2, date: '2026-08-25', modelValue: null });
    // The watcher's async handler has started but not yet resolved — loading renders first.
    await Promise.resolve();
    expect(wrapper.text()).toContain(es.loading);

    resolve({ ok: true, data: { date: '2026-08-25', slots: [], open: true, outside_window: false } });
    await flushPromises();
    expect(wrapper.text()).not.toContain(es.loading);
  });

  it('shows the amber outside-window message when the date is past the booking window', async () => {
    vi.mocked(getAvailability).mockResolvedValue({
      ok: true,
      data: { date: '2026-12-01', slots: [], open: true, outside_window: true },
    });
    const wrapper = mountPicker({ professionalId: 1, serviceId: 2, date: '2026-12-01', modelValue: null });
    await flushPromises();

    expect(wrapper.text()).toContain(es.calendar.outsideBookingWindow);
    const amber = wrapper.find('.text-amber-700');
    expect(amber.exists()).toBe(true);
    expect(amber.text()).toBe(es.calendar.outsideBookingWindow);
  });

  it('distinguishes a fully-booked working day from a day the professional does not work', async () => {
    // mockResolvedValue (not -Once): SlotPicker also prefetches both neighbouring days in the
    // background, which would otherwise hit an empty mock queue and reject unhandled.
    vi.mocked(getAvailability).mockResolvedValue({
      ok: true,
      data: { date: '2026-08-25', slots: [], open: true, outside_window: false },
    });
    const booked = mountPicker({ professionalId: 1, serviceId: 2, date: '2026-08-25', modelValue: null });
    await flushPromises();
    expect(booked.text()).toContain(es.calendar.dayFullyBooked);
    expect(booked.text()).not.toContain(es.calendar.dayNotWorked);

    vi.mocked(getAvailability).mockResolvedValue({
      ok: true,
      data: { date: '2026-08-26', slots: [], open: false, outside_window: false },
    });
    const notWorked = mountPicker({ professionalId: 1, serviceId: 2, date: '2026-08-26', modelValue: null });
    await flushPromises();
    expect(notWorked.text()).toContain(es.calendar.dayNotWorked);
    expect(notWorked.text()).not.toContain(es.calendar.dayFullyBooked);
  });

  it('renders a button per slot with its duration, and marks the selected one aria-pressed', async () => {
    vi.mocked(getAvailability).mockResolvedValue({
      ok: true,
      data: {
        date: '2026-08-25',
        open: true,
        outside_window: false,
        slots: [
          { start: '09:00', end: '09:50' },
          { start: '10:00', end: '10:50' },
        ],
      },
    });
    const wrapper = mountPicker({ professionalId: 1, serviceId: 2, date: '2026-08-25', modelValue: '10:00' });
    await flushPromises();

    const buttons = wrapper.findAll('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0].text()).toContain('09:00');
    expect(buttons[0].text()).toContain('50m');
    expect(buttons[0].attributes('aria-pressed')).toBe('false');
    expect(buttons[1].attributes('aria-pressed')).toBe('true');

    await buttons[0].trigger('click');
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['09:00']);
    expect(wrapper.emitted('slotSelected')?.at(-1)).toEqual([{ start: '09:00', end: '09:50' }]);
  });
});
