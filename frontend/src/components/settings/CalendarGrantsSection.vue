<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useStateLabel } from '@/composables/useStateLabel';
import { useToast } from '@/composables/useToast';
import { listGrants, listGrantableStaff, createGrant, revokeGrant } from '@/api/grants';
import { apiErrorMessage } from '@/i18n/api-errors';
import type { CalendarGrant, GrantableStaff } from '@/api/grants';
import AppButton from '@/components/shared/AppButton.vue';
import FieldError from '@/components/shared/FieldError.vue';
import Selector from '@/components/shared/Selector.vue';

const props = defineProps<{ professionalUserId: number | null }>();

const { t } = useI18n();
const { roleLabel } = useStateLabel();
const { success, error } = useToast();

const staff = ref<GrantableStaff[]>([]);
const grants = ref<CalendarGrant[]>([]);
const loading = ref(false);
const selectedGranteeId = ref<string | null>(null);
const granting = ref(false);
const grantError = ref('');
const revokingId = ref<string | null>(null);

onMounted(async () => {
  const res = await listGrantableStaff();
  if (res.ok) staff.value = res.data;
});

async function loadGrants() {
  if (props.professionalUserId == null) {
    grants.value = [];
    return;
  }
  loading.value = true;
  const res = await listGrants(props.professionalUserId);
  loading.value = false;
  if (res.ok) grants.value = res.data;
}

// A leftover selection from a previously-viewed professional must not survive the switch —
// otherwise "Grant" could bind it to the wrong professional.
watch(
  () => props.professionalUserId,
  () => {
    selectedGranteeId.value = null;
    grantError.value = '';
    loadGrants();
  },
  { immediate: true },
);

const grantableOptions = computed(() => {
  const grantedIds = new Set(grants.value.map((g) => g.grantee_user_id));
  return staff.value
    .filter((s) => String(s.id) !== String(props.professionalUserId) && !grantedIds.has(s.id))
    .map((s) => ({ value: s.id, label: s.display_name ?? s.username }));
});

async function grant() {
  if (props.professionalUserId == null || selectedGranteeId.value == null) return;
  grantError.value = '';
  granting.value = true;
  const res = await createGrant({
    professional_user_id: props.professionalUserId,
    grantee_user_id: Number(selectedGranteeId.value),
  });
  granting.value = false;
  if (res.ok) {
    selectedGranteeId.value = null;
    success('saved');
    await loadGrants();
  } else {
    grantError.value = apiErrorMessage(res);
  }
}

async function revoke(id: string) {
  revokingId.value = id;
  const res = await revokeGrant(id);
  revokingId.value = null;
  if (res.ok) {
    success('saved');
    await loadGrants();
  } else {
    error('genericError');
  }
}
</script>

<template>
  <div class="space-y-4">
    <p v-if="professionalUserId == null" class="text-sm text-neutral">
      {{ t('grants.selectProfessional') }}
    </p>

    <template v-else>
      <div v-if="loading" class="text-sm text-neutral">…</div>
      <p v-else-if="grants.length === 0" class="text-sm text-neutral">
        {{ t('grants.noneYet') }}
      </p>
      <ul v-else class="space-y-2">
        <li
          v-for="g in grants"
          :key="g.id"
          class="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
        >
          <span class="flex min-w-0 items-center gap-2 text-sm">
            <span class="truncate font-medium">{{ g.grantee_username }}</span>
            <span class="shrink-0 rounded bg-surface px-2 py-0.5 text-xs text-neutral">{{ roleLabel(g.grantee_role) }}</span>
          </span>
          <AppButton
            variant="destructive"
            size="md"
            class="shrink-0"
            :loading="revokingId === g.id"
            @click="revoke(g.id)"
          >
            {{ t('grants.removeAccess') }}
          </AppButton>
        </li>
      </ul>

      <div class="flex flex-wrap items-end gap-3 border-t border-border pt-4">
        <label class="flex min-w-[220px] flex-1 flex-col gap-1 text-sm">
          <span class="font-medium text-neutral">{{ t('grants.giveAccessTo') }}</span>
          <Selector
            id="grant-grantee-select"
            v-model="selectedGranteeId"
            :options="grantableOptions"
            :placeholder="t('generic.select')"
            :label-if-single="false"
          />
        </label>
        <AppButton
          variant="primary"
          :disabled="selectedGranteeId == null"
          :loading="granting"
          @click="grant"
        >
          {{ t('grants.giveAccess') }}
        </AppButton>
      </div>
      <FieldError :message="grantError" />
    </template>
  </div>
</template>
