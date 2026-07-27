<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { apiErrorMessage } from '@/i18n/api-errors';
import { useToast } from '@/composables/useToast';
import { useAuthStore } from '@/stores/auth';
import AppButton from '@/components/shared/AppButton.vue';
import FieldError from '@/components/shared/FieldError.vue';
import PasswordInput from '@/components/shared/PasswordInput.vue';
import { isPasswordReused } from '@shared/ssot/domain/people';

// One implementation of "change your own password", embedded wherever a role can reach it
// (forced post-login screen, staff profile, staff settings, portal preferences) — every entry
// point calls the same store action and reuses the same reuse-check, so they can't drift.
const props = withDefaults(defineProps<{
  currentPasswordId?: string;
  newPasswordId?: string;
  submitId?: string;
  toastOnSuccess?: boolean;
  buttonFullWidth?: boolean;
}>(), {
  currentPasswordId: 'current-password',
  newPasswordId: 'new-password',
  submitId: undefined,
  toastOnSuccess: true,
  buttonFullWidth: false,
});

const emit = defineEmits<{ success: [] }>();

const { t } = useI18n();
const { success } = useToast();
const auth = useAuthStore();

const currentPassword = ref('');
const newPassword = ref('');
const loading = ref(false);
const serverError = ref('');

// A new password that just repeats the current one is rejected — surface it as they type,
// not only when they submit. Same rule the server enforces (shared/src/ssot/domain/people.ts).
const samePassword = computed(() => isPasswordReused(newPassword.value, currentPassword.value));

// A stale server error shouldn't linger once they start editing.
watch([currentPassword, newPassword], () => {
  serverError.value = '';
});

const errorMessage = computed(() =>
  samePassword.value ? t('apiError.passwordReuse') : serverError.value,
);

async function submit() {
  if (samePassword.value) return; // warning already visible; nothing to submit
  serverError.value = '';
  loading.value = true;
  try {
    const result = await auth.changePassword(currentPassword.value, newPassword.value);
    if (!result.ok) {
      serverError.value = apiErrorMessage(result, 'toast.genericError');
      return;
    }
    currentPassword.value = '';
    newPassword.value = '';
    if (props.toastOnSuccess) success('saved');
    emit('success');
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <form @submit.prevent="submit" novalidate class="space-y-4">
    <div class="flex flex-col gap-1">
      <label :for="currentPasswordId" class="text-sm font-semibold">
        {{ t('auth.currentPasswordLabel') }}
      </label>
      <PasswordInput
        :id="currentPasswordId"
        v-model="currentPassword"
        autocomplete="current-password"
        required
        :input-class="[
          'w-full max-w-md rounded-md border px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          errorMessage ? 'border-destructive' : 'border-border',
        ]"
      />
    </div>

    <div class="flex flex-col gap-1">
      <label :for="newPasswordId" class="text-sm font-semibold">
        {{ t('auth.newPasswordLabel') }}
      </label>
      <PasswordInput
        :id="newPasswordId"
        v-model="newPassword"
        autocomplete="new-password"
        required
        :input-class="[
          'w-full max-w-md rounded-md border px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          errorMessage ? 'border-destructive' : 'border-border',
        ]"
      />
      <FieldError :message="errorMessage" />
    </div>

    <AppButton
      :id="submitId"
      type="submit"
      variant="primary"
      :loading="loading"
      :disabled="samePassword"
      :class="buttonFullWidth ? 'w-full' : undefined"
    >
      {{ t('actions.changePassword') }}
    </AppButton>
  </form>
</template>
