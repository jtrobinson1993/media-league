<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter, RouterLink } from 'vue-router';
import { api, ApiError } from '../api';
import { useSession } from '../stores/session';

const route = useRoute();
const router = useRouter();
const session = useSession();

const code = route.params.code as string;
const preview = ref<{ scope: string; name?: string; groupName?: string } | null>(null);
const error = ref('');
const busy = ref(false);

onMounted(async () => {
  try {
    preview.value = await api.get(`/api/invites/${code}`);
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'invite not found';
  }
});

async function accept(): Promise<void> {
  if (!session.me) {
    void router.push({ name: 'login', query: { next: `/join/${code}` } });
    return;
  }
  busy.value = true;
  try {
    const res = await api.post<{ joined: { groupId: number; leagueId?: number } }>(`/api/invites/${code}/accept`);
    void router.push(res.joined.leagueId ? `/leagues/${res.joined.leagueId}` : `/groups/${res.joined.groupId}`);
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'could not join';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="mx-auto mt-16 max-w-sm text-center">
    <p class="text-4xl">🎟️</p>
    <template v-if="preview">
      <h1 class="mt-3 text-xl font-bold">You're invited</h1>
      <p class="mt-1 text-neutral-500">
        Join <span class="font-semibold text-neutral-900 dark:text-neutral-100">{{ preview.name }}</span>
        <template v-if="preview.scope === 'league'"> in {{ preview.groupName }}</template>
      </p>
      <button
        class="mt-6 w-full rounded-lg bg-amber-500 py-2 font-semibold text-white disabled:opacity-50"
        :disabled="busy"
        @click="accept"
      >
        {{ session.me ? 'Join' : 'Sign in to join' }}
      </button>
    </template>
    <p v-if="error" class="mt-4 text-sm text-red-600">{{ error }}</p>
    <RouterLink to="/" class="mt-6 block text-sm text-neutral-500">← Home</RouterLink>
  </div>
</template>
