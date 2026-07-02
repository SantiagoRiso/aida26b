<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import type { Appointment } from '@/api/appointments';
import RequestFlow from '@/components/portal/RequestFlow.vue';
import AppButton from '@/components/shared/AppButton.vue';

const router = useRouter();
const confirmedAppt = ref<Appointment | null>(null);

function onSuccess(appt: Appointment) {
  confirmedAppt.value = appt;
}

function goToAppointments() {
  router.push({ name: 'portal-appointments' });
}
</script>

<template>
  <div class="space-y-6">
    <h1 class="text-2xl font-bold">Solicitar turno</h1>

    <div v-if="confirmedAppt" class="space-y-4">
      <div class="rounded-lg border border-green-200 bg-green-50 px-6 py-4">
        <p class="text-base font-semibold text-success">¡Solicitud enviada!</p>
        <p class="mt-1 text-sm text-neutral">
          Tu solicitud de turno #{{ confirmedAppt.id }} está en estado
          <strong>Solicitado</strong> y será revisada por el equipo.
          Te avisaremos cuando sea aprobada.
        </p>
      </div>
      <AppButton @click="goToAppointments">
        Ver mis turnos
      </AppButton>
    </div>

    <RequestFlow v-else @success="onSuccess" />
  </div>
</template>
