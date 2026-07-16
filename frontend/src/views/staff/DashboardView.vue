<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useCurrency } from '@/composables/useCurrency';
import { useStateLabel } from '@/composables/useStateLabel';
import { auditOutcomeBadgeClass } from '@/composables/badgeTone';
import { useAppointmentLabels } from '@/composables/useAppointmentLabels';
import { useProfessionalDashboard } from '@/composables/useProfessionalDashboard';
import { useReceptionistDashboard } from '@/composables/useReceptionistDashboard';
import { useAdminDashboard } from '@/composables/useAdminDashboard';
import { useConflictTriage } from '@/composables/useConflictTriage';
import { useSettleCard } from '@/composables/useSettleCard';
import Skeleton from '@/components/shared/Skeleton.vue';
import EmptyState from '@/components/shared/EmptyState.vue';
import AppButton from '@/components/shared/AppButton.vue';
import ConfirmDialog from '@/components/shared/ConfirmDialog.vue';
import ConflictOverrideDialog from '@/components/calendar/ConflictOverrideDialog.vue';

const { t } = useI18n();
const auth = useAuthStore();
const router = useRouter();
const { formatDateTime, formatARS } = useCurrency();
const { stateLabel } = useStateLabel();

const role = computed(() => auth.user?.role);

const { proUpcoming, proPending, loadingPro, loadProfessional } = useProfessionalDashboard();
const { recToday, recPending, loadingRec, loadReceptionist } = useReceptionistDashboard();
const { adminTodayCount, adminPendingCount, recentAudit, loadingAdmin, loadAdmin } = useAdminDashboard();

const {
  conflictTurnos, conflictTotal, loadConflicts, conflictBusy, resolveTarget,
  ignoreConflict, goReschedule, confirmResolve, approveConflict,
  conflictOpen, conflictVerdict, conflictRevert, onOverrideConfirm, onOverrideCancel,
} = useConflictTriage();

// Owns its own timers and refetch lifecycle.
const { showsCard, currentAppointments, amounts, processing, canSettle, settle } = useSettleCard();

const { apptLabel, pendingClientName, clientDniFor, serviceNameFor, professionalNameFor } =
  useAppointmentLabels();

onMounted(() => {
  if (role.value === 'Professional') loadProfessional();
  else if (role.value === 'Receptionist') loadReceptionist();
  else if (role.value === 'Admin') loadAdmin();
  if (role.value !== 'Client') void loadConflicts();
});
</script>

<template>
  <div>
    <h1 class="text-2xl font-semibold mb-6">
      {{ t('nav.dashboard') }}
    </h1>

    <div v-if="showsCard && currentAppointments.length" class="mb-6 space-y-4">
      <div
        v-for="appt in currentAppointments"
        :key="appt.id"
        class="rounded-lg border-2 border-accent bg-card p-5"
      >
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div class="min-w-0">
            <div class="text-xs font-semibold uppercase tracking-wide text-accent">
              {{ t('dashboard.currentAppointment') }}
            </div>
            <h2 class="mt-1 text-lg font-semibold text-heading">{{ apptLabel(appt) }}</h2>
            <p class="text-sm text-neutral">
              {{ formatDateTime(appt.starts_at) }}
              <span v-if="serviceNameFor(appt)"> · {{ serviceNameFor(appt) }}</span>
              <span v-if="role === 'Receptionist' && professionalNameFor(appt)"> · {{ professionalNameFor(appt) }}</span>
            </p>
          </div>
          <div class="text-right">
            <div class="text-xs text-neutral">{{ t('calendar.priceLabel') }}</div>
            <div class="text-lg font-semibold tabular-nums">{{ appt.price ? formatARS(appt.price) : '—' }}</div>
          </div>
        </div>

        <div class="mt-4 flex flex-wrap items-end gap-3">
          <div class="flex flex-col gap-1">
            <label class="text-xs font-semibold text-neutral" :for="`pay-${appt.id}`">
              {{ t('dashboard.paymentArs') }}
            </label>
            <input
              :id="`pay-${appt.id}`"
              v-model="amounts[appt.id]"
              type="text"
              inputmode="decimal"
              :disabled="!canSettle(appt)"
              class="w-36 rounded-md border border-border bg-card px-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-accent disabled:bg-surface disabled:text-neutral"
            />
          </div>
          <AppButton variant="primary" :loading="processing[appt.id]" :disabled="!canSettle(appt)" @click="settle(appt, 'paid')">
            {{ t('dashboard.paid') }}
          </AppButton>
          <AppButton variant="neutral" :disabled="processing[appt.id] || !canSettle(appt)" @click="settle(appt, 'unpaid')">
            {{ t('dashboard.notPaid') }}
          </AppButton>
          <AppButton variant="neutral" :disabled="processing[appt.id] || !canSettle(appt)" @click="settle(appt, 'absent')">
            {{ stateLabel('no_show') }}
          </AppButton>
          <p v-if="!canSettle(appt)" class="text-xs text-neutral">
            {{ t('dashboard.notStartedYet') }}
          </p>
        </div>
      </div>
    </div>

    <div v-if="conflictTurnos.length" class="mb-6 rounded-lg border-2 border-destructive bg-card p-5">
      <h2 class="text-lg font-semibold text-heading">
        {{ t('dashboard.conflictsHeading') }}
        <span class="ml-2 text-sm font-normal text-destructive">({{ conflictTotal }})</span>
      </h2>
      <p class="mt-1 text-sm text-neutral">
        {{ t('dashboard.conflictsBody') }}
      </p>
      <ul class="mt-3 max-h-72 space-y-2 overflow-y-auto">
        <li
          v-for="appt in conflictTurnos"
          :key="appt.id"
          :data-testid="`conflict-${appt.id}`"
          class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border pb-2 text-sm last:border-0 last:pb-0"
        >
          <span class="flex flex-wrap items-center gap-2">
            <span class="font-semibold text-heading">{{ formatDateTime(appt.starts_at) }}</span>
            <span>{{ apptLabel(appt) }}</span>
            <span v-if="role !== 'Professional' && professionalNameFor(appt)" class="text-neutral">
              · {{ professionalNameFor(appt) }}
            </span>
          </span>
          <span class="flex items-center gap-3 text-xs font-semibold">
            <button type="button" class="text-neutral hover:underline disabled:opacity-50" :disabled="conflictBusy[appt.id]" @click="ignoreConflict(appt)">
              {{ t('dashboard.ignore') }}
            </button>
            <button v-if="appt.state === 'requested'" type="button" class="text-success hover:underline" @click="approveConflict(appt)">
              {{ t('calendar.approve') }}
            </button>
            <button type="button" class="text-accent hover:underline" @click="goReschedule">
              {{ t('calendar.reschedule') }}
            </button>
            <button
              type="button"
              class="text-destructive hover:underline"
              @click="resolveTarget = { appt, to: appt.state === 'requested' ? 'rejected' : 'canceled' }"
            >
              {{ appt.state === 'requested' ? t('dashboard.deny') : t('actions.cancel') }}
            </button>
          </span>
        </li>
      </ul>
    </div>

    <template v-if="role === 'Professional'">
      <div v-if="loadingPro">
        <Skeleton variant="tile" :rows="2" />
      </div>
      <div v-else class="grid grid-cols-1 gap-6 md:grid-cols-2">
        <div class="rounded-lg border border-border bg-card p-5">
          <h2 class="text-lg font-semibold text-heading mb-3">
            {{ t('portal.upcomingHeading') }}
          </h2>
          <ul v-if="proUpcoming.length" class="space-y-2">
            <li
              v-for="appt in proUpcoming"
              :key="appt.id"
              class="text-sm text-neutral border-b border-border pb-2 last:border-0 last:pb-0"
            >
              <span class="font-semibold text-heading">{{ formatDateTime(appt.starts_at) }}</span>
              <span class="ml-2">{{ apptLabel(appt) }}</span>
            </li>
          </ul>
          <EmptyState
            v-else
            :heading="t('dashboard.noUpcoming')"
            body=""
          />
        </div>

        <div class="rounded-lg border border-border bg-card p-5">
          <h2 class="text-lg font-semibold text-heading mb-3">
            {{ t('dashboard.pendingRequests') }}
          </h2>
          <ul v-if="proPending.length" class="space-y-2">
            <li
              v-for="appt in proPending"
              :key="appt.id"
              class="text-sm text-neutral border-b border-border pb-2 last:border-0 last:pb-0"
            >
              <span class="font-semibold text-heading">{{ formatDateTime(appt.starts_at) }}</span>
              <span class="ml-2">{{ pendingClientName(appt) }}</span>
              <span v-if="clientDniFor(appt.client_user_id)" class="ml-2 text-xs">
                DNI {{ clientDniFor(appt.client_user_id) }}
              </span>
            </li>
          </ul>
          <EmptyState
            v-else
            :heading="t('dashboard.noRequests')"
            body=""
          />
        </div>
      </div>
    </template>

    <template v-else-if="role === 'Receptionist'">
      <div v-if="loadingRec">
        <Skeleton variant="tile" :rows="2" />
      </div>
      <div v-else class="grid grid-cols-1 gap-6 md:grid-cols-2">
        <div class="rounded-lg border border-border bg-card p-5">
          <h2 class="text-lg font-semibold text-heading mb-3">
            {{ t('dashboard.todayAppointments') }}
            <span class="ml-2 text-sm text-neutral">({{ recToday.length }})</span>
          </h2>
          <ul v-if="recToday.length" class="space-y-2 max-h-64 overflow-y-auto">
            <li
              v-for="appt in recToday"
              :key="appt.id"
              class="text-sm text-neutral border-b border-border pb-2 last:border-0 last:pb-0"
            >
              <span class="font-semibold text-heading">{{ formatDateTime(appt.starts_at) }}</span>
              <span class="ml-2">{{ apptLabel(appt) }}</span>
              <span v-if="professionalNameFor(appt)" class="ml-2">· {{ professionalNameFor(appt) }}</span>
            </li>
          </ul>
          <EmptyState v-else :heading="t('dashboard.noAppointmentsToday')" body="" />
        </div>

        <div class="rounded-lg border border-border bg-card p-5">
          <h2 class="text-lg font-semibold text-heading mb-3">
            {{ t('dashboard.requestsToTriage') }}
            <span class="ml-2 text-sm text-neutral">({{ recPending.length }})</span>
          </h2>
          <ul v-if="recPending.length" class="space-y-2 max-h-48 overflow-y-auto">
            <li
              v-for="appt in recPending"
              :key="appt.id"
              class="text-sm text-neutral border-b border-border pb-2 last:border-0 last:pb-0"
            >
              <span class="font-semibold text-heading">{{ formatDateTime(appt.starts_at) }}</span>
              <span class="ml-2">{{ apptLabel(appt) }}</span>
            </li>
          </ul>
          <EmptyState v-else :heading="t('requests.emptyHeading')" body="" />

          <div class="mt-4">
            <AppButton variant="primary" @click="router.push('/staff/calendar')">
              {{ t('actions.newAppointment') }}
            </AppButton>
          </div>
        </div>
      </div>
    </template>

    <template v-else-if="role === 'Admin'">
      <div v-if="loadingAdmin">
        <Skeleton variant="tile" :rows="3" />
      </div>
      <div v-else>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-3 mb-6">
          <div class="rounded-lg border border-border bg-card p-4 text-center">
            <div class="text-3xl font-semibold text-heading tabular-nums">{{ adminTodayCount }}</div>
            <div class="mt-1 text-sm text-neutral">{{ t('dashboard.appointmentsToday') }}</div>
          </div>
          <div class="rounded-lg border border-border bg-card p-4 text-center">
            <div class="text-3xl font-semibold text-heading tabular-nums">{{ adminPendingCount }}</div>
            <div class="mt-1 text-sm text-neutral">{{ t('dashboard.pendingRequests') }}</div>
          </div>
          <div class="rounded-lg border border-border bg-card p-4 text-center">
            <div class="text-3xl font-semibold text-heading tabular-nums">{{ recentAudit.length }}</div>
            <div class="mt-1 text-sm text-neutral">{{ t('dashboard.recentAuditEvents') }}</div>
          </div>
        </div>

        <div class="mb-6 flex flex-wrap gap-3">
          <AppButton variant="neutral" @click="router.push('/staff/users')">
            {{ t('nav.users') }}
          </AppButton>
          <AppButton variant="neutral" @click="router.push('/staff/settings')">
            {{ t('nav.settings') }}
          </AppButton>
          <AppButton variant="neutral" @click="router.push('/staff/audit')">
            {{ t('dashboard.viewAudit') }}
          </AppButton>
        </div>

        <div class="rounded-lg border border-border bg-card p-5">
          <h2 class="text-lg font-semibold text-heading mb-3">
            {{ t('dashboard.recentActivity') }}
          </h2>
          <ul v-if="recentAudit.length" class="space-y-2">
            <li
              v-for="event in recentAudit"
              :key="event.id"
              class="flex items-center justify-between text-sm border-b border-border pb-2 last:border-0 last:pb-0"
            >
              <span class="text-neutral">{{ formatDateTime(event.created_at) }}</span>
              <span class="font-mono text-xs text-heading">{{ event.event_type }}</span>
              <span
                class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold"
                :class="auditOutcomeBadgeClass(event.outcome)"
              >
                {{ event.outcome }}
              </span>
            </li>
          </ul>
          <EmptyState v-else :heading="t('dashboard.noRecentActivity')" body="" />
        </div>
      </div>
    </template>

    <ConfirmDialog
      :open="resolveTarget !== null"
      :title="resolveTarget?.to === 'rejected'
        ? t('dashboard.denyRequestTitle')
        : t('calendar.cancel')"
      :body="resolveTarget?.to === 'rejected'
        ? t('dashboard.denyRequestBody')
        : t('dashboard.cancelConflictBody')"
      :confirm-label="resolveTarget?.to === 'rejected'
        ? t('dashboard.deny')
        : t('calendar.cancel')"
      destructive
      @confirm="confirmResolve"
      @cancel="resolveTarget = null"
    />

    <ConflictOverrideDialog
      :open="conflictOpen"
      :verdict="conflictVerdict"
      :revert="conflictRevert"
      @confirm="onOverrideConfirm"
      @cancel="onOverrideCancel"
    />
  </div>
</template>
