<script setup lang="ts">
import { ref, reactive } from 'vue';
import { useI18n } from 'vue-i18n';
import { apiErrorMessage } from '@/i18n/api-errors';
import { useLabel } from '@/composables/useLabel';
import { createUser, deactivateUser, resetPassword } from '@/api/admin-users';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/composables/useToast';
import type { TableRecordMap } from '@shared/ssot/derived';
import { ROLE_OPTIONS } from '@shared/ssot/domain';
import { structure } from '@shared/ssot/structure';
import GenericTable from '@/components/generic/GenericTable.vue';
import DetailPanel from '@/components/shared/DetailPanel.vue';
import ConfirmDialog from '@/components/shared/ConfirmDialog.vue';
import FieldError from '@/components/shared/FieldError.vue';
import AppButton from '@/components/shared/AppButton.vue';
import PasswordInput from '@/components/shared/PasswordInput.vue';

const { t } = useI18n();
const { label } = useLabel();
const { toast } = useToast();
const auth = useAuthStore();

const TABLE_KEY = 'users' as const;
const usersColumns = structure.tables.users.columns;

// Self-deactivation locks the account out and a self "admin reset" bypasses change-password;
// the backend rejects both; the UI must not offer them.
function isSelf(row: TableRecordMap['users']): boolean {
  return String(row.id) === String(auth.user?.id);
}

// Users are listed via generic /api/users (SSOT users is read-exposed).
// Create/deactivate/reset all route through admin-users API, not generic CRUD.

const reloadKey = ref(0);

const createPanelOpen = ref(false);
const createSubmitting = ref(false);
const createErrors = reactive<Record<string, string>>({});
const createForm = reactive({
  username: '',
  email: '',
  password: '',
  role: '',
  display_name: '',
});

function openCreate() {
  Object.assign(createForm, { username: '', email: '', password: '', role: '', display_name: '' });
  Object.keys(createErrors).forEach((k) => delete createErrors[k]);
  createPanelOpen.value = true;
}

async function submitCreate() {
  createSubmitting.value = true;
  Object.keys(createErrors).forEach((k) => delete createErrors[k]);
  try {
    const result = await createUser({
      username: createForm.username,
      email: createForm.email || undefined,
      password: createForm.password,
      role: createForm.role,
      display_name: createForm.display_name || undefined,
    });
    if (result.ok) {
      createPanelOpen.value = false;
      reloadKey.value++;
    } else {
      createErrors['_'] = apiErrorMessage(result, 'users.createError');
    }
  } finally {
    createSubmitting.value = false;
  }
}

const deactivateConfirmOpen = ref(false);
const pendingDeactivateId = ref<string | null>(null);
const pendingDeactivateName = ref('');
const deactivateSubmitting = ref(false);

function requestDeactivate(row: TableRecordMap['users']) {
  pendingDeactivateId.value = String(row.id);
  pendingDeactivateName.value = String(row.username ?? row.id);
  deactivateConfirmOpen.value = true;
}

async function confirmDeactivate() {
  if (!pendingDeactivateId.value) return;
  deactivateSubmitting.value = true;
  deactivateConfirmOpen.value = false;
  try {
    const result = await deactivateUser(pendingDeactivateId.value);
    if (result.ok) {
      reloadKey.value++;
    } else {
      toast('error', 'genericError');
    }
  } finally {
    deactivateSubmitting.value = false;
    pendingDeactivateId.value = null;
  }
}

const resetPanelOpen = ref(false);
const resetUserId = ref<string | null>(null);
const resetPassword_ = ref('');
const resetSubmitting = ref(false);
const resetError = ref('');

function openReset(row: TableRecordMap['users']) {
  resetUserId.value = String(row.id);
  resetPassword_.value = '';
  resetError.value = '';
  resetPanelOpen.value = true;
}

async function submitReset() {
  if (!resetUserId.value || !resetPassword_.value) return;
  resetSubmitting.value = true;
  resetError.value = '';
  try {
    const result = await resetPassword(resetUserId.value, resetPassword_.value);
    if (result.ok) {
      resetPanelOpen.value = false;
    } else {
      resetError.value = apiErrorMessage(result, 'users.resetError');
    }
  } finally {
    resetSubmitting.value = false;
  }
}
</script>

<template>
  <div>
    <GenericTable
      :key="reloadKey"
      :table-key="TABLE_KEY"
      empty-value="-"
    >
      <template #header-actions>
        <AppButton @click="openCreate">
          {{ t('users.addUser') }}
        </AppButton>
      </template>
      <template #row-actions="{ row }">
        <template v-if="!isSelf(row)">
          <button
            type="button"
            class="mr-3 text-accent hover:underline text-xs"
            @click.stop="openReset(row)"
          >
            {{ t('users.resetPassword') }}
          </button>
          <button
            v-if="row.is_active"
            type="button"
            class="mr-2 text-destructive hover:underline text-xs"
            @click.stop="requestDeactivate(row)"
          >
            {{ t('users.deactivate') }}
          </button>
        </template>
      </template>
    </GenericTable>

    <DetailPanel
      :open="createPanelOpen"
      :title="t('users.newUser')"
      @close="createPanelOpen = false"
    >
      <form class="space-y-4" @submit.prevent="submitCreate" novalidate>
        <FieldError :message="createErrors['_']" />

        <div class="flex flex-col gap-1">
          <label for="username" class="text-sm font-semibold">
            {{ t('auth.usernameLabel') }} <span class="text-destructive">*</span>
          </label>
          <input
            id="username"
            v-model="createForm.username"
            type="text"
            class="rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            required
          />
        </div>

        <div class="flex flex-col gap-1">
          <label for="email" class="text-sm font-semibold">{{ label(usersColumns.email.label) }}</label>
          <input
            id="email"
            v-model="createForm.email"
            type="email"
            class="rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>

        <div class="flex flex-col gap-1">
          <label for="password" class="text-sm font-semibold">
            {{ t('auth.passwordLabel') }} <span class="text-destructive">*</span>
          </label>
          <PasswordInput
            id="password"
            v-model="createForm.password"
            input-class="w-full rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            required
          />
        </div>

        <div class="flex flex-col gap-1">
          <label for="role" class="text-sm font-semibold">
            {{ label(usersColumns.role.label) }} <span class="text-destructive">*</span>
          </label>
          <select
            id="role"
            v-model="createForm.role"
            class="rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            required
          >
            <option value="">{{ t('generic.selectPlaceholder') }}</option>
            <option v-for="r in ROLE_OPTIONS" :key="r.value" :value="r.value">{{ label(r.label) }}</option>
          </select>
        </div>

        <div class="flex flex-col gap-1">
          <label for="display_name" class="text-sm font-semibold">{{ t('fields.displayName') }}</label>
          <input
            id="display_name"
            v-model="createForm.display_name"
            type="text"
            class="rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>

        <div class="flex justify-end gap-3 pt-2">
          <AppButton variant="neutral" type="button" @click="createPanelOpen = false">
            {{ t('actions.cancel') }}
          </AppButton>
          <AppButton type="submit" :loading="createSubmitting">
            {{ t('actions.save') }}
          </AppButton>
        </div>
      </form>
    </DetailPanel>

    <ConfirmDialog
      :open="deactivateConfirmOpen"
      :title="t('users.deactivateTitle')"
      :body="t('users.deactivateBody', { name: pendingDeactivateName })"
      :confirm-label="t('users.deactivate')"
      :destructive="true"
      @confirm="confirmDeactivate"
      @cancel="deactivateConfirmOpen = false"
    />

    <DetailPanel
      :open="resetPanelOpen"
      :title="t('users.resetPassword')"
      @close="resetPanelOpen = false"
    >
      <form class="space-y-4" @submit.prevent="submitReset" novalidate>
        <FieldError :message="resetError" />
        <div class="flex flex-col gap-1">
          <label for="new-password" class="text-sm font-semibold">
            {{ t('auth.newPasswordLabel') }} <span class="text-destructive">*</span>
          </label>
          <PasswordInput
            id="new-password"
            v-model="resetPassword_"
            input-class="w-full rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            required
          />
        </div>
        <div class="flex justify-end gap-3 pt-2">
          <AppButton variant="neutral" type="button" @click="resetPanelOpen = false">
            {{ t('actions.cancel') }}
          </AppButton>
          <AppButton type="submit" :loading="resetSubmitting">
            {{ t('actions.save') }}
          </AppButton>
        </div>
      </form>
    </DetailPanel>
  </div>
</template>
