<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import AppButton from '@/components/shared/AppButton.vue';
import FieldError from '@/components/shared/FieldError.vue';

const { t } = useI18n();
const router = useRouter();
const auth = useAuthStore();

const currentPassword = ref('');
const newPassword = ref('');
const loading = ref(false);
const fieldError = ref('');

async function submit() {
  fieldError.value = '';
  if (newPassword.value === currentPassword.value) {
    fieldError.value = t('auth.samePasswordError');
    return;
  }
  loading.value = true;
  try {
    const result = await auth.changePassword(currentPassword.value, newPassword.value);
    if (!result.ok) {
      // Never expose raw error codes to the user.
      fieldError.value = result.message ?? t('toast.genericError');
      return;
    }
    if (auth.user?.role === 'Client') {
      await router.push({ name: 'portal-appointments' });
    } else {
      await router.push({ name: 'staff-dashboard' });
    }
  } finally {
    loading.value = false;
  }
}

// A user forced to change their password is otherwise trapped on this screen; give them a way out.
async function logout() {
  await auth.logout();
  await router.push({ name: 'login' });
}
</script>

<template>
  <!-- Full-screen blocking form: guard prevents leaving while must_change_password is true. -->
  <div class="flex min-h-screen flex-col items-center justify-center bg-surface px-4">
    <div class="w-full max-w-sm rounded-xl bg-card p-8 shadow-sm border border-border">
      <div class="mb-6 rounded-md bg-warning/10 border border-warning/30 px-4 py-3 text-sm text-warning font-semibold">
        {{ t('auth.mustChangeBanner') }}
      </div>

      <h1 class="mb-6 text-xl font-semibold">{{ t('actions.changePassword') }}</h1>

      <form @submit.prevent="submit" novalidate>
        <div class="mb-4">
          <label for="current-password" class="block text-sm font-semibold mb-1">
            {{ t('auth.currentPasswordLabel') }}
          </label>
          <input
            id="current-password"
            v-model="currentPassword"
            type="password"
            autocomplete="current-password"
            required
            :class="[
              'w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              fieldError ? 'border-destructive' : 'border-border',
            ]"
          />
        </div>

        <div class="mb-6">
          <label for="new-password" class="block text-sm font-semibold mb-1">
            {{ t('auth.newPasswordLabel') }}
          </label>
          <input
            id="new-password"
            v-model="newPassword"
            type="password"
            autocomplete="new-password"
            required
            :class="[
              'w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              fieldError ? 'border-destructive' : 'border-border',
            ]"
          />
          <FieldError :message="fieldError" />
        </div>

        <AppButton type="submit" variant="primary" :loading="loading" class="w-full">
          {{ t('actions.changePassword') }}
        </AppButton>
      </form>

      <button
        type="button"
        class="mt-4 w-full text-center text-sm text-neutral hover:underline"
        @click="logout"
      >
        {{ t('nav.logout') }}
      </button>
    </div>
  </div>
</template>
