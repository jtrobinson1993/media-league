<script setup lang="ts">
import { ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { startAuthentication } from '@simplewebauthn/browser';
import { useSession } from '../stores/session';
import { api, ApiError } from '../api';

const session = useSession();
const router = useRouter();
const route = useRoute();

const mode = ref<'login' | 'register'>('login');
const username = ref('');
const password = ref('');
const displayName = ref('');
const error = ref('');
const notice = ref('');
const busy = ref(false);

function afterAuth(): void {
  const next = (route.query.next as string) ?? '/';
  void router.push(next);
}

async function submit(): Promise<void> {
  error.value = '';
  busy.value = true;
  try {
    if (mode.value === 'register') {
      notice.value = await session.register(username.value, password.value, displayName.value);
      // Show the no-recovery notice once before continuing (SPEC §6).
      setTimeout(afterAuth, 3500);
      return;
    }
    await session.login(username.value, password.value);
    afterAuth();
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'something went wrong';
  } finally {
    busy.value = false;
  }
}

async function passkeyLogin(): Promise<void> {
  error.value = '';
  try {
    const res = await fetch('/api/auth/passkeys/login-options', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: username.value || undefined }),
    });
    const options = await res.json();
    const challengeKey = res.headers.get('x-challenge-key');
    const assertion = await startAuthentication({ optionsJSON: options });
    await api.post('/api/auth/passkeys/login-verify', { challengeKey, response: assertion });
    await session.load();
    afterAuth();
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'passkey sign-in failed';
  }
}
</script>

<template>
  <div class="mx-auto mt-12 max-w-sm">
    <h1 class="mb-1 text-center text-3xl font-bold">🎬 Media League</h1>
    <p class="mb-8 text-center text-sm text-neutral-500">Submit. Vote. Crown a champion.</p>

    <div v-if="notice" class="rounded-lg border border-amber-400 bg-amber-50 p-4 text-sm dark:bg-amber-950">
      <p class="font-semibold">⚠️ Heads up</p>
      <p>{{ notice }}</p>
      <p class="mt-2 text-neutral-500">Taking you in…</p>
    </div>

    <form v-else class="space-y-3" @submit.prevent="submit">
      <div class="flex rounded-lg bg-neutral-100 p-1 text-sm dark:bg-neutral-900">
        <button
          v-for="m in ['login', 'register'] as const"
          :key="m"
          type="button"
          class="flex-1 rounded-md py-1.5 capitalize"
          :class="mode === m ? 'bg-white font-semibold shadow dark:bg-neutral-800' : 'text-neutral-500'"
          @click="mode = m"
        >
          {{ m === 'login' ? 'Sign in' : 'Create account' }}
        </button>
      </div>

      <input
        v-model="username"
        placeholder="username"
        autocomplete="username"
        class="w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 dark:border-neutral-700"
      />
      <input
        v-model="password"
        type="password"
        placeholder="password"
        :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
        class="w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 dark:border-neutral-700"
      />
      <input
        v-if="mode === 'register'"
        v-model="displayName"
        placeholder="display name (optional)"
        class="w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 dark:border-neutral-700"
      />

      <p v-if="error" class="text-sm text-red-600">{{ error }}</p>

      <button
        type="submit"
        :disabled="busy || !username || !password"
        class="w-full rounded-lg bg-amber-500 py-2 font-semibold text-white disabled:opacity-50"
      >
        {{ mode === 'login' ? 'Sign in' : 'Create account' }}
      </button>

      <button
        v-if="mode === 'login'"
        type="button"
        class="w-full rounded-lg border border-neutral-300 py-2 text-sm dark:border-neutral-700"
        @click="passkeyLogin"
      >
        🔑 Sign in with a passkey
      </button>

      <p v-if="mode === 'register'" class="text-xs text-neutral-500">
        There is no password reset — keep your credentials safe. You can add a passkey after signing up.
      </p>
    </form>
  </div>
</template>
