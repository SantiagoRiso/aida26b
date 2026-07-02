<script setup lang="ts">
defineProps<{
  message?: string;
}>();
</script>

<template>
  <p
    v-if="message"
    role="alert"
    class="mt-1 text-sm text-destructive"
  >
    {{ message }}
  </p>
</template>
