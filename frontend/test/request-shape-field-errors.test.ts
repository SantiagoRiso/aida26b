import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { fieldErrorMessages } from '@/i18n/api-errors';
import { i18n } from '@/i18n';
import AppointmentForm from '@/components/calendar/AppointmentForm.vue';

vi.mock('@/api/crud', () => ({
  listRows: vi.fn().mockResolvedValue({ ok: true, data: [] }),
}));
vi.mock('@/api/scheduling', () => ({
  getAvailability: vi.fn().mockResolvedValue({ ok: true, data: { slots: [] } }),
  getBookingWindow: vi.fn().mockResolvedValue({ ok: true, data: { min_date: '2000-01-01', max_date: null } }),
}));

// The workflow routes now answer a malformed body the same way a table write does: a stable key
// per field. These are the keys those routes emit.
const REQUEST_SHAPE_KEYS = [
  'required',
  'positiveInteger',
  'dateFormat',
  'timeOfDayFormat',
  'notBoolean',
  'notString',
  'notInOptions',
  'maxLength',
  'invalidId',
  'ownerToken',
  'notAllowedWithRange',
  'dateRangeOrder',
  'dateRangeTooLong',
  'notInSeries',
] as const;

describe('workflow-route field keys resolve in both bundles', () => {
  it('every key a converted route can emit is defined and non-empty in es and en', () => {
    for (const key of REQUEST_SHAPE_KEYS) {
      expect(es.fieldError[key], `es.fieldError.${key}`).toBeTruthy();
      expect(en.fieldError[key], `en.fieldError.${key}`).toBeTruthy();
    }
  });

  it('an interpolated key renders its bound rather than leaving the placeholder', () => {
    i18n.global.locale.value = 'es';
    const messages = fieldErrorMessages({
      ok: false,
      code: 'invalid_request',
      status: 422,
      message: 'Invalid availability query',
      fieldDetails: { date_to: { key: 'dateRangeTooLong', params: { max: 42 } } },
    });
    expect(messages.date_to).toContain('42');
    expect(messages.date_to).not.toContain('{max}');
    expect(messages.date_to).not.toBe(es.fieldError.fallback);
  });

  it('a route-emitted key resolves to its own message, not the generic fallback', () => {
    i18n.global.locale.value = 'es';
    const messages = fieldErrorMessages({
      ok: false,
      code: 'invalid_request',
      status: 422,
      message: 'Invalid availability query',
      fieldDetails: {
        owner: { key: 'ownerToken' },
        date: { key: 'notAllowedWithRange' },
        date_from: { key: 'dateFormat' },
      },
    });
    expect(messages.owner).toBe(es.fieldError.ownerToken);
    expect(messages.date).toBe(es.fieldError.notAllowedWithRange);
    expect(messages.date_from).toBe(es.fieldError.dateFormat);
  });
});

describe('AppointmentForm renders a keyed rejection', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.resetModules();
  });

  it('shows the translated per-field message a converted route returned', async () => {
    const scheduleAppointment = vi.fn().mockResolvedValue({
      ok: false,
      code: 'invalid_request',
      status: 422,
      message: 'Invalid appointment input',
      fields: { date: 'date must be YYYY-MM-DD' },
      fieldDetails: { date: { key: 'dateFormat' } },
    });
    vi.doMock('@/api/appointments', () => ({
      scheduleAppointment,
      rescheduleAppointment: vi.fn(),
      scheduleSeries: vi.fn(),
    }));
    const { default: Form } = await import('@/components/calendar/AppointmentForm.vue');

    const wrapper = mount(Form, {
      props: { prefillDate: '2026-07-20', prefillStart: '10:00', prefillDuration: 50 },
      global: { plugins: [createI18n({ legacy: false, locale: 'es', messages: { es, en } })] },
    });
    await flushPromises();

    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(scheduleAppointment).toHaveBeenCalled();
    // English server prose never reaches the screen; the key it carried is what renders.
    expect(wrapper.text()).toContain(es.fieldError.dateFormat);
    expect(wrapper.text()).not.toContain('date must be YYYY-MM-DD');
  });

  it('a locally-caught missing duration reads the same required message the server would send', async () => {
    const wrapper = mount(AppointmentForm, {
      props: { prefillDate: '2026-07-20' },
      global: { plugins: [createI18n({ legacy: false, locale: 'es', messages: { es, en } })] },
    });
    await flushPromises();

    // No time and no duration: the form surfaces the manual section and flags both fields itself.
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(wrapper.text()).toContain(es.fieldError.required);
    // 'Requerido' was the old bespoke label; the ladder replaced it.
    expect(wrapper.text()).not.toContain(es.generic.required);
  });
});

// seriesRule.ts used to collapse every recurrence violation onto one generic message, discarding
// the rule the shared validator had already named. Nothing in the app may import the prose-only
// projection of a shared validator again — the keyed one is the only path to a translated UI.
describe('no frontend source may flatten a shared validator to prose', () => {
  const PROSE_ONLY_EXPORTS = ['validateRecurrenceRule', 'validateField'];

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return /\.(ts|vue)$/.test(entry.name) ? [full] : [];
    });
  }

  it('imports only the keyed validators', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(__dirname, '../src'))) {
      const text = readFileSync(file, 'utf8');
      for (const line of text.split('\n')) {
        if (!/^\s*import\b/.test(line) && !/\bfrom\s+'@shared\//.test(line)) continue;
        for (const name of PROSE_ONLY_EXPORTS) {
          // Word-boundary match so validateFieldIssue / validateRecurrenceRuleIssues pass.
          if (new RegExp(`\\b${name}\\b(?!Issue)`).test(line)) offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
