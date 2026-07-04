<script setup lang="ts">
import { computed } from 'vue';
import { RouterView, RouterLink, useRoute } from 'vue-router';
import { useSession } from './stores/session';
import { useAlerts } from './stores/alerts';

const session = useSession();
const alerts = useAlerts();
const route = useRoute();
const showNav = computed(() => session.me && route.name !== 'login' && route.name !== 'join');
</script>

<template>
  <div class="flex min-h-dvh flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
    <main class="mx-auto w-full max-w-3xl flex-1 px-4 pb-20 pt-4">
      <RouterView />
    </main>
    <nav
      v-if="showNav"
      class="fixed inset-x-0 bottom-0 z-10 border-t border-neutral-200 bg-white/90 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/90"
    >
      <div class="mx-auto flex max-w-3xl justify-around py-2">
        <RouterLink to="/" class="rounded px-4 py-1 text-sm" active-class="font-bold text-amber-600 dark:text-amber-400">
          🏠 Home
        </RouterLink>
        <RouterLink to="/alerts" class="relative rounded px-4 py-1 text-sm" active-class="font-bold text-amber-600 dark:text-amber-400">
          🔔 Alerts
          <span
            v-if="alerts.unread > 0"
            class="absolute -right-1 -top-1 rounded-full bg-amber-500 px-1.5 text-xs font-bold text-white"
          >
            {{ alerts.unread }}
          </span>
        </RouterLink>
        <RouterLink to="/me" class="rounded px-4 py-1 text-sm" active-class="font-bold text-amber-600 dark:text-amber-400">
          👤 Me
        </RouterLink>
      </div>
    </nav>
  </div>
</template>
