<script setup lang="ts">
// Hosts the calendar's overlays: appointment detail panel, the new/reschedule form panel, the
// move-confirm dialog, and the conflict-override dialog. All state lives in the parent view;
// this component only renders and re-emits.
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Appointment, AppointmentSeries, ScheduleSeriesBody } from '@/api/appointments';
import { endSeries, transitionAppointment, getSeries, splitSeriesFuture, updateSeries } from '@/api/appointments';
import { resolveActionable } from '@/composables/seriesOccurrence';
import { buildReschedulePatch } from '@/composables/seriesRule';
import { useToast } from '@/composables/useToast';
import type { ConflictVerdict } from '@shared/ssot/domain/conflict';
import AppointmentDetailPanel from '@/components/calendar/AppointmentDetailPanel.vue';
import AppointmentForm from '@/components/calendar/AppointmentForm.vue';
import ConflictOverrideDialog from '@/components/calendar/ConflictOverrideDialog.vue';
import SeriesScopeDialog from '@/components/calendar/SeriesScopeDialog.vue';
import type { SeriesScope, SeriesScopeAction } from '@/components/calendar/SeriesScopeDialog.vue';
import SeriesRuleForm from '@/components/calendar/SeriesRuleForm.vue';
import SeriesRescheduleForm from '@/components/calendar/SeriesRescheduleForm.vue';
import DetailPanel from '@/components/shared/DetailPanel.vue';
import ConfirmDialog from '@/components/shared/ConfirmDialog.vue';

const props = defineProps<{
  detailAppointment: Appointment | null;
  detailOpen: boolean;
  formOpen: boolean;
  formAppointment?: Appointment;
  prefillDate?: string;
  prefillStart?: string;
  prefillProfessionalId?: number;
  prefillResourceId?: number;
  prefillSobreturno: boolean;
  prefillDuration?: number;
  moveConfirmOpen: boolean;
  moveConfirmBody: string;
  conflictOpen: boolean;
  conflictVerdict: ConflictVerdict | null;
  conflictRevert: (() => void) | null;
}>();

const emit = defineEmits<{
  'detail-close': [];
  'detail-mutated': [appt: Appointment];
  reschedule: [appt: Appointment];
  approve: [appt: Appointment];
  'form-close': [];
  'form-saved': [appt: Appointment];
  'form-conflict': [verdict: ConflictVerdict, retryFn: (override: boolean) => Promise<void>];
  'move-confirm': [];
  'move-cancel': [];
  'override-confirm': [];
  'override-cancel': [];
  // A series action with no single resulting appointment (this-and-future / whole series ended)
  // fired — the parent just needs to refetch the list.
  'series-mutated': [];
}>();

const { t } = useI18n();
const toast = useToast();

// Keep the form mounted through the close animation (cleared on @after-leave) so the panel
// doesn't blank mid-close; opening flips it true via the watcher below.
const formMounted = ref(false);
watch(() => props.formOpen, (open) => { if (open) formMounted.value = true; });

// Scope chooser: shared by cancel, reschedule, and the rule editor's save step. Owns its own
// open/target state (the choice — and the calls it drives — is local to this dialog, not the
// calendar's drag/move flow). `scopeAction` picks which branch onScopeSelect takes; `pendingRulePatch`
// only applies to the edit-rule branch (set right before opening, alongside the scope dialog).
const scopeOpen = ref(false);
const scopeTarget = ref<Appointment | null>(null);
const scopeAction = ref<SeriesScopeAction>('cancel');
const pendingRulePatch = ref<Partial<ScheduleSeriesBody> | null>(null);

function onCancelSeries(appt: Appointment) {
  scopeAction.value = 'cancel';
  scopeTarget.value = appt;
  scopeOpen.value = true;
}

function onRescheduleSeries(appt: Appointment) {
  scopeAction.value = 'reschedule';
  scopeTarget.value = appt;
  scopeOpen.value = true;
}

function onScopeCancel() {
  scopeOpen.value = false;
  scopeTarget.value = null;
  pendingRulePatch.value = null;
}

async function onScopeSelect(scope: SeriesScope) {
  const appt = scopeTarget.value;
  const action = scopeAction.value;
  const rulePatch = pendingRulePatch.value;
  scopeOpen.value = false;
  scopeTarget.value = null;
  pendingRulePatch.value = null;
  if (!appt || appt.series_id == null) return;
  const seriesId = appt.series_id;

  if (action === 'cancel') {
    if (scope === 'this') {
      const actionable = await resolveActionable(appt);
      if (!actionable) { toast.error('genericError'); return; }
      const result = await transitionAppointment(actionable.id, 'canceled');
      if (result.ok) emit('detail-mutated', result.data);
      else toast.error('genericError');
      return;
    }

    const result = scope === 'future'
      ? await endSeries(seriesId, appt.occurrence_date ?? undefined)
      : await endSeries(seriesId);
    if (result.ok) {
      emit('detail-close');
      emit('series-mutated');
    } else {
      toast.error('genericError');
    }
    return;
  }

  if (action === 'reschedule') {
    if (scope === 'this') {
      const actionable = await resolveActionable(appt);
      if (!actionable) { toast.error('genericError'); return; }
      emit('reschedule', actionable);
      return;
    }

    // future/whole never touch this one row — they only need the series' current rule (for the
    // weekday decision), fetched here rather than carried on the appointment.
    const seriesResult = await getSeries(seriesId);
    if (!seriesResult.ok) { toast.error('genericError'); return; }
    seriesRescheduleAppt.value = appt;
    seriesRescheduleSeries.value = seriesResult.data;
    seriesRescheduleScope.value = scope;
    seriesRescheduleOpen.value = true;
    return;
  }

  // action === 'edit-rule' — 'this' is never offered (see SeriesScopeDialog), so scope is
  // 'future' or 'whole' here.
  if (!rulePatch) return;
  const result = scope === 'future'
    ? await splitSeriesFuture(seriesId, appt.occurrence_date ?? '', rulePatch)
    : await updateSeries(seriesId, rulePatch);
  if (result.ok) {
    emit('detail-close');
    emit('series-mutated');
  } else {
    toast.error('genericError');
  }
}

// "Editar serie": prefilled from the fetched series (the appointment row itself carries no rule
// fields), then on save the scope chooser decides this-and-future vs. whole-series.
const ruleEditorOpen = ref(false);
const ruleEditorAppt = ref<Appointment | null>(null);
const ruleEditorSeries = ref<AppointmentSeries | null>(null);

async function onEditSeriesRule(appt: Appointment) {
  if (appt.series_id == null) return;
  const result = await getSeries(appt.series_id);
  if (!result.ok) { toast.error('genericError'); return; }
  ruleEditorAppt.value = appt;
  ruleEditorSeries.value = result.data;
  ruleEditorOpen.value = true;
}

function onRuleEditorCancel() {
  ruleEditorOpen.value = false;
  ruleEditorAppt.value = null;
  ruleEditorSeries.value = null;
}

function onRuleEditorSaved(patch: Partial<ScheduleSeriesBody>) {
  ruleEditorOpen.value = false;
  const appt = ruleEditorAppt.value;
  ruleEditorAppt.value = null;
  ruleEditorSeries.value = null;
  if (!appt) return;
  scopeAction.value = 'edit-rule';
  scopeTarget.value = appt;
  pendingRulePatch.value = patch;
  scopeOpen.value = true;
}

// This-and-future / whole-series reschedule (Part 1's future/whole path): the time picker opens
// only after the scope is chosen (see onScopeSelect's 'reschedule' branch above).
const seriesRescheduleOpen = ref(false);
const seriesRescheduleAppt = ref<Appointment | null>(null);
const seriesRescheduleSeries = ref<AppointmentSeries | null>(null);
const seriesRescheduleScope = ref<'future' | 'whole'>('future');

function resetSeriesReschedule() {
  seriesRescheduleOpen.value = false;
  seriesRescheduleAppt.value = null;
  seriesRescheduleSeries.value = null;
}

async function onSeriesRescheduleSubmit(date: string, start: string) {
  const appt = seriesRescheduleAppt.value;
  const series = seriesRescheduleSeries.value;
  if (!appt || !series || appt.series_id == null) return;
  const patch = buildReschedulePatch(series, date, start);
  const result = seriesRescheduleScope.value === 'future'
    ? await splitSeriesFuture(appt.series_id, appt.occurrence_date ?? date, patch)
    : await updateSeries(appt.series_id, patch);
  if (result.ok) {
    resetSeriesReschedule();
    emit('detail-close');
    emit('series-mutated');
  } else {
    toast.error('genericError');
  }
}
</script>

<template>
  <AppointmentDetailPanel
    :appointment="detailAppointment"
    :open="detailOpen"
    @close="emit('detail-close')"
    @mutated="emit('detail-mutated', $event)"
    @reschedule="emit('reschedule', $event)"
    @approve="(appt) => emit('approve', appt)"
    @cancel-series="onCancelSeries"
    @reschedule-series="onRescheduleSeries"
    @edit-series-rule="onEditSeriesRule"
  />

  <DetailPanel
    :open="formOpen"
    :title="formAppointment ? t('calendar.reschedule') : t('calendar.newAppointment')"
    variant="side"
    size="2xl"
    @close="emit('form-close')"
    @after-leave="formMounted = false"
  >
    <AppointmentForm
      v-if="formMounted"
      :appointment="formAppointment"
      :prefill-date="prefillDate"
      :prefill-start="prefillStart"
      :prefill-professional-id="prefillProfessionalId"
      :prefill-resource-id="prefillResourceId"
      :prefill-sobreturno="prefillSobreturno"
      :prefill-duration="prefillDuration"
      @saved="emit('form-saved', $event)"
      @conflict-detected="(verdict, retryFn) => emit('form-conflict', verdict, retryFn)"
      @cancel="emit('form-close')"
    />
  </DetailPanel>

  <ConfirmDialog
    :open="moveConfirmOpen"
    :title="t('calendar.reschedule')"
    :body="moveConfirmBody"
    :confirm-label="t('actions.confirm')"
    @confirm="emit('move-confirm')"
    @cancel="emit('move-cancel')"
  />

  <ConflictOverrideDialog
    :open="conflictOpen"
    :verdict="conflictVerdict"
    :revert="conflictRevert"
    @confirm="emit('override-confirm')"
    @cancel="emit('override-cancel')"
  />

  <DetailPanel
    :open="ruleEditorOpen"
    :title="t('calendar.editSeriesTitle')"
    variant="side"
    @close="onRuleEditorCancel"
  >
    <SeriesRuleForm
      v-if="ruleEditorSeries"
      :series="ruleEditorSeries"
      @saved="onRuleEditorSaved"
      @cancel="onRuleEditorCancel"
    />
  </DetailPanel>

  <DetailPanel
    :open="seriesRescheduleOpen"
    :title="t('calendar.rescheduleSeriesTitle')"
    variant="side"
    @close="resetSeriesReschedule"
  >
    <SeriesRescheduleForm
      v-if="seriesRescheduleAppt"
      :appointment="seriesRescheduleAppt"
      @submit="onSeriesRescheduleSubmit"
      @cancel="resetSeriesReschedule"
    />
  </DetailPanel>

  <SeriesScopeDialog
    :open="scopeOpen"
    :action="scopeAction"
    @select="onScopeSelect"
    @cancel="onScopeCancel"
  />
</template>
