<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { api, ApiError } from '../api';

interface AdminUser { id: number; username: string; displayName: string | null; suspended: number; isOperator: number }

const stats = ref<Record<string, number> | null>(null);
const users = ref<AdminUser[]>([]);
const q = ref('');
const message = ref('');
const error = ref('');
const resetTarget = ref<AdminUser | null>(null);
const newPassword = ref('');

async function load(): Promise<void> {
  stats.value = await api.get('/api/admin/stats');
  await searchUsers();
}

async function searchUsers(): Promise<void> {
  const res = await api.get<{ users: AdminUser[] }>(`/api/admin/users?q=${encodeURIComponent(q.value)}`);
  users.value = res.users;
}

async function act(fn: () => Promise<unknown>, ok: string): Promise<void> {
  error.value = '';
  message.value = '';
  try {
    await fn();
    message.value = ok;
    await load();
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'failed';
  }
}

const suspend = (u: AdminUser) =>
  act(() => api.post(`/api/admin/users/${u.id}/suspend`, { suspended: !u.suspended }), u.suspended ? 'unsuspended' : 'suspended');

const resetPassword = () =>
  act(async () => {
    await api.post(`/api/admin/users/${resetTarget.value!.id}/reset-password`, { newPassword: newPassword.value });
    resetTarget.value = null;
    newPassword.value = '';
  }, 'password reset');

const clearPasskeys = (u: AdminUser) => act(() => api.post(`/api/admin/users/${u.id}/clear-passkeys`), 'passkeys cleared');

onMounted(load);
</script>

<template>
  <div>
    <RouterLink to="/me" class="text-sm text-neutral-500">← Profile</RouterLink>
    <h1 class="mt-1 text-2xl font-bold">Operator console</h1>

    <div v-if="stats" class="mt-4 grid grid-cols-5 gap-2 text-center">
      <div v-for="(v, k) in stats" :key="k" class="rounded-xl border border-neutral-200 p-2 dark:border-neutral-800">
        <div class="font-bold">{{ v }}</div>
        <div class="text-[10px] text-neutral-500">{{ k }}</div>
      </div>
    </div>

    <p v-if="message" class="mt-3 text-sm text-emerald-600">✓ {{ message }}</p>
    <p v-if="error" class="mt-3 text-sm text-red-600">{{ error }}</p>

    <section class="mt-6">
      <input v-model="q" placeholder="🔍 Search users…" class="w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm dark:border-neutral-700" @input="searchUsers" />
      <div v-for="u in users" :key="u.id" class="flex items-center gap-2 border-b border-neutral-100 py-2.5 text-sm dark:border-neutral-900">
        <span class="flex-1">
          {{ u.username }}
          <span v-if="u.isOperator" class="text-xs text-amber-600">operator</span>
          <span v-if="u.suspended" class="text-xs text-red-500">suspended</span>
        </span>
        <button class="text-xs underline" @click="resetTarget = u">reset pw</button>
        <button class="text-xs underline" @click="clearPasskeys(u)">clear keys</button>
        <button class="text-xs underline" :class="u.suspended ? 'text-emerald-600' : 'text-red-500'" @click="suspend(u)">
          {{ u.suspended ? 'unsuspend' : 'suspend' }}
        </button>
      </div>
    </section>

    <div v-if="resetTarget" class="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4" @click.self="resetTarget = null">
      <div class="w-full max-w-sm rounded-xl bg-white p-4 dark:bg-neutral-900">
        <p class="font-semibold">Reset password for {{ resetTarget.username }}</p>
        <input v-model="newPassword" type="text" placeholder="new password (min 8 chars)" class="mt-3 w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm dark:border-neutral-700" />
        <div class="mt-3 flex justify-end gap-2 text-sm">
          <button class="rounded-lg border border-neutral-300 px-3 py-1.5 dark:border-neutral-700" @click="resetTarget = null">Cancel</button>
          <button class="rounded-lg bg-amber-500 px-3 py-1.5 font-semibold text-white" @click="resetPassword">Reset</button>
        </div>
      </div>
    </div>
  </div>
</template>
