import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import ExceptionList from '@/components/calendar/ExceptionList.vue';
import ConfirmDialog from '@/components/shared/ConfirmDialog.vue';
import { deleteRow } from '@/api/crud';
import type { ExceptionRow } from '@/composables/scheduleExceptions';
import type { ApiResult } from '@/api/client';

vi.mock('@/api/crud', () => ({
  deleteRow: vi.fn().mockResolvedValue({ ok: true, data: {} }),
}));

function makeI18n() {
  return createI18n({ legacy: false, locale: 'es', messages: { es, en } });
}

const rows: ExceptionRow[] = [
  {
    id: '1',
    professional_user_id: '10',
    resource_id: null,
    exception_date: '2026-07-15',
    is_unavailable: true,
    start_time: null,
    end_time: null,
    granularity_minutes: null,
    reason: 'Vacaciones',
  },
  {
    id: '2',
    professional_user_id: '10',
    resource_id: null,
    exception_date: '2026-07-16',
    is_unavailable: false,
    start_time: '18:00',
    end_time: '20:00',
    granularity_minutes: 30,
    reason: null,
  },
];

function mountList(rowsProp: ExceptionRow[] = rows) {
  return mount(ExceptionList, {
    props: { rows: rowsProp },
    global: { plugins: [makeI18n()] },
  });
}

describe('ExceptionList', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(deleteRow).mockClear();
    vi.mocked(deleteRow).mockResolvedValue({ ok: true, data: {} } as ApiResult<ExceptionRow>);
  });

  it('renders a row per exception', () => {
    const wrapper = mountList();
    expect(wrapper.find('[data-testid="exception-row-1"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="exception-row-2"]').exists()).toBe(true);
  });

  it('deletes the row on confirm and emits deleted', async () => {
    const wrapper = mountList();
    await wrapper.get('[data-testid="exception-delete-1"]').trigger('click');
    await wrapper.findComponent(ConfirmDialog).vm.$emit('confirm');
    await flushPromises();

    expect(deleteRow).toHaveBeenCalledWith('schedule_exceptions', '1');
    expect(wrapper.emitted('deleted')).toBeTruthy();
  });

  it('does not call deleteRow when the confirm dialog is canceled', async () => {
    const wrapper = mountList();
    await wrapper.get('[data-testid="exception-delete-2"]').trigger('click');
    await wrapper.findComponent(ConfirmDialog).vm.$emit('cancel');
    await flushPromises();

    expect(deleteRow).not.toHaveBeenCalled();
    expect(wrapper.emitted('deleted')).toBeFalsy();
  });

  it('does not emit deleted when the delete request fails', async () => {
    vi.mocked(deleteRow).mockResolvedValueOnce({ ok: false, status: 500, code: 'SERVER_ERROR', message: 'boom' } as ApiResult<ExceptionRow>);
    const wrapper = mountList();
    await wrapper.get('[data-testid="exception-delete-1"]').trigger('click');
    await wrapper.findComponent(ConfirmDialog).vm.$emit('confirm');
    await flushPromises();

    expect(deleteRow).toHaveBeenCalledWith('schedule_exceptions', '1');
    expect(wrapper.emitted('deleted')).toBeFalsy();
  });
});
