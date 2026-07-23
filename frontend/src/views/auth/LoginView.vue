<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import AppButton from '@/components/shared/AppButton.vue';
import FieldError from '@/components/shared/FieldError.vue';
import PasswordInput from '@/components/shared/PasswordInput.vue';

const { t } = useI18n();
const router = useRouter();
const auth = useAuthStore();

const username = ref('');
const password = ref('');
const loading = ref(false);
// Inline credential error — not a session-expired toast (apiFetch entry-mode handles that split).
const credError = ref('');

async function submit() {
  credError.value = '';
  loading.value = true;
  try {
    const result = await auth.login(username.value, password.value);
    if (!result.ok) {
      // Only a 401 is bad credentials; a 500/other means the server (or its DB) is unavailable —
      // don't blame the user's password for a server-side failure.
      credError.value = result.status === 401 ? t('toast.invalidCredentials') : t('toast.serverUnavailable');
      return;
    }
    // If must_change_password is set, the guard will bounce to change-password.
    if (auth.user?.role === 'Client') {
      await router.push({ name: 'portal-appointments' });
    } else {
      await router.push({ name: 'staff-dashboard' });
    }
  } catch {
    // The backend was unreachable (fetch rejected before any response) — same server-down message.
    credError.value = t('toast.serverUnavailable');
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <!-- No language switch on this screen; renders in the default/last-saved language. -->
  <!-- The auth screens render outside both shells, so the landmark lives here: without it the
       whole page sits outside any region and a screen reader has nothing to jump to. -->
  <main class="flex min-h-screen items-center justify-center bg-surface px-4">
    <div class="w-full max-w-sm rounded-xl bg-card p-8 shadow-sm border border-border">
      <h1 class="mb-6 text-2xl font-semibold text-center">AIDA</h1>

      <form @submit.prevent="submit" novalidate>
        <div class="mb-4">
          <label for="username" class="block text-sm font-semibold mb-1">
            {{ t('auth.usernameLabel') }}
          </label>
          <input
            id="username"
            v-model="username"
            type="text"
            autocomplete="username"
            required
            :class="[
              'w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              credError ? 'border-destructive' : 'border-border',
            ]"
          />
        </div>

        <div class="mb-6">
          <label for="password" class="block text-sm font-semibold mb-1">
            {{ t('auth.passwordLabel') }}
          </label>
          <PasswordInput
            id="password"
            v-model="password"
            autocomplete="current-password"
            required
            :input-class="[
              'w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              credError ? 'border-destructive' : 'border-border',
            ]"
          />
          <!-- Generic message, no username hint — avoid leaking which field was wrong. -->
          <FieldError :message="credError" />
        </div>

        <AppButton type="submit" variant="primary" :loading="loading" class="w-full">
          {{ t('actions.login') }}
        </AppButton>
      </form>
    </div>
  </main>
</template>
