import { ref, reactive, computed } from 'vue';
import type { Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { apiErrorMessage } from '@/i18n/api-errors';
import { deleteRow } from '@/api/crud';
import { enableClientLogin } from '@/api/admin-users';
import { useAuthStore } from '@/stores/auth';
import { roleAllowedFor, descriptorWriteRoles } from '@/router/access';
import { useToast } from '@/composables/useToast';
import type { TableRecordMap } from '@shared/ssot/derived';

export function useClientAccount(
  clientId: number,
  deps: {
    client: Ref<TableRecordMap['clients'] | null>;
    reloadProfile: () => Promise<void>;
    onChanged: () => void;
    onClose: () => void;
  },
) {
  const auth = useAuthStore();
  const toast = useToast();
  const { t } = useI18n();
const role = computed(() => auth.user?.role);

  const canDeactivate = computed(() => !!role.value && roleAllowedFor(descriptorWriteRoles('clients', 'delete'), role.value));
  // Contact-only client (no username) — offer to turn it into a logging-in account.
  const canEnableLogin = computed(() => deps.client.value != null && deps.client.value.username == null);

  const deactivateConfirmOpen = ref(false);

  async function confirmDeactivate() {
    deactivateConfirmOpen.value = false;
    const res = await deleteRow('clients', clientId);
    if (res.ok) {
      deps.onChanged();
      deps.onClose();
    } else {
      toast.error('genericError');
    }
  }

  const showEnableLogin = ref(false);
  const enableLoginSubmitting = ref(false);
  const enableLoginError = ref('');
  const enableLoginForm = reactive({ username: '', password: '' });

  async function submitEnableLogin() {
    enableLoginSubmitting.value = true;
    enableLoginError.value = '';
    try {
      const res = await enableClientLogin(clientId, {
        username: enableLoginForm.username,
        password: enableLoginForm.password,
      });
      if (res.ok) {
        showEnableLogin.value = false;
        toast.success('saved');
        deps.onChanged();
        await deps.reloadProfile();
      } else {
        enableLoginError.value = apiErrorMessage(res, 'users.createError');
      }
    } finally {
      enableLoginSubmitting.value = false;
    }
  }

  return {
    canDeactivate,
    canEnableLogin,
    deactivateConfirmOpen,
    confirmDeactivate,
    showEnableLogin,
    enableLoginSubmitting,
    enableLoginError,
    enableLoginForm,
    submitEnableLogin,
  };
}
