<script setup lang="ts">
import { RouterView, RouterLink } from 'vue-router';
</script>

<template>
  <div class="flex min-h-dvh flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
    <main class="flex-1 pb-16">
      <RouterView />
    </main>
    <nav
      class="fixed inset-x-0 bottom-0 flex justify-around border-t border-neutral-200 bg-white/90 py-2 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/90"
    >
      <RouterLink to="/" class="px-4 py-1 text-sm" active-class="font-bold">🏠 Home</RouterLink>
      <RouterLink to="/alerts" class="px-4 py-1 text-sm" active-class="font-bold">🔔 Alerts</RouterLink>
      <RouterLink to="/me" class="px-4 py-1 text-sm" active-class="font-bold">👤 Me</RouterLink>
    </nav>
  </div>
</template>
