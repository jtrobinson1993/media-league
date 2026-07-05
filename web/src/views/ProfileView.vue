<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter, RouterLink } from 'vue-router';
import { startRegistration } from '@simplewebauthn/browser';
import { api, ApiError } from '../api';
import { useSession } from '../stores/session';
import UserAvatar from '../components/UserAvatar.vue';

const session = useSession();
const router = useRouter();

interface StoreItem { id: string; type: string; name: string; price: number; asset: string }

const profile = ref<{ username: string; displayName: string | null; avatar: { kind: string; id?: string; color: string }; coins: number; equipped: Record<string, string>; isOperator: boolean } | null>(null);
const store = ref<{ items: StoreItem[]; owned: string[] } | null>(null);
const passkeys = ref<{ id: string; createdAt: number }[]>([]);
const message = ref('');
const error = ref('');

const GALLERY = ['slasher-mask', 'robot', 'alien', 'film-reel', 'vampire', 'ghost', 'clown', 'popcorn', 'zombie', 'detective', 'astronaut', 'dinosaur'];
const GALLERY_EMOJI: Record<string, string> = {
  'slasher-mask': '🎭', robot: '🤖', alien: '👽', 'film-reel': '🎞️', vampire: '🧛', ghost: '👻',
  clown: '🤡', popcorn: '🍿', zombie: '🧟', detective: '🕵️', astronaut: '🧑‍🚀', dinosaur: '🦖',
};

async function load(): Promise<void> {
  profile.value = await api.get('/api/me/profile');
  const s = await api.get<{ items: StoreItem[]; owned: string[]; coins: number; equipped: Record<string, string> }>('/api/store');
  store.value = { items: s.items, owned: s.owned };
  const pk = await api.get<{ passkeys: { id: string; createdAt: number }[] }>('/api/auth/passkeys');
  passkeys.value = pk.passkeys;
}

const fileInput = ref<HTMLInputElement | null>(null);

async function uploadPhoto(ev: Event): Promise<void> {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  error.value = '';
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    error.value = 'use a jpeg, png, or webp image';
    return;
  }
  if (file.size > 2 * 1024 * 1024) {
    error.value = 'image must be under 2 MB';
    return;
  }
  const res = await fetch('/api/me/avatar-photo', { method: 'PUT', headers: { 'content-type': file.type }, body: file });
  if (!res.ok) {
    error.value = 'upload failed';
    return;
  }
  await load();
}

async function pickAvatar(id: string | null): Promise<void> {
  const avatar = id ? { kind: 'gallery', id, color: profile.value?.avatar.color ?? 'auto' } : { kind: 'initials', color: 'auto' };
  await api.patch('/api/me/profile', { avatar });
  await load();
}

async function buyOrEquip(item: StoreItem): Promise<void> {
  error.value = '';
  try {
    if (store.value?.owned.includes(item.id)) {
      const equipped = profile.value?.equipped.frame === item.id;
      await api.post('/api/store/equip', { type: 'frame', itemId: equipped ? null : item.id });
    } else {
      await api.post('/api/store/buy', { itemId: item.id });
    }
    await load();
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'store error';
  }
}

async function addPasskey(): Promise<void> {
  error.value = '';
  message.value = '';
  try {
    const options = await api.post<Record<string, unknown>>('/api/auth/passkeys/register-options');
    const attestation = await startRegistration({ optionsJSON: options as never });
    await api.post('/api/auth/passkeys/register-verify', attestation);
    message.value = '✓ Passkey added';
    await load();
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'passkey setup failed';
  }
}

async function removePasskey(id: string): Promise<void> {
  await api.delete(`/api/auth/passkeys/${encodeURIComponent(id)}`);
  await load();
}

async function logout(): Promise<void> {
  await session.logout();
  void router.push('/login');
}

onMounted(load);
</script>

<template>
  <div v-if="profile">
    <div class="flex items-center gap-4">
      <UserAvatar :username="profile.username" :display-name="profile.displayName" :avatar="profile.avatar" :user-id="session.me?.id" :frame="store?.items.find((i) => i.id === profile!.equipped.frame)?.asset ?? null" size="lg" />
      <div>
        <h1 class="text-2xl font-bold">{{ profile.displayName || profile.username }}</h1>
        <p class="text-sm text-neutral-500">@{{ profile.username }} · 🪙 {{ profile.coins }}</p>
        <RouterLink v-if="profile.isOperator" to="/admin" class="text-xs text-amber-600 underline dark:text-amber-400">Operator console</RouterLink>
      </div>
    </div>

    <p v-if="message" class="mt-3 text-sm text-emerald-600">{{ message }}</p>
    <p v-if="error" class="mt-3 text-sm text-red-600">{{ error }}</p>

    <!-- avatar picker -->
    <section class="mt-6">
      <h2 class="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">Avatar</h2>
      <div class="flex flex-wrap gap-2">
        <button class="flex h-11 w-11 items-center justify-center rounded-full border text-xs font-bold" :class="profile.avatar.kind === 'initials' ? 'border-amber-500' : 'border-neutral-300 dark:border-neutral-700'" @click="pickAvatar(null)">Aa</button>
        <button v-for="g in GALLERY" :key="g" class="flex h-11 w-11 items-center justify-center rounded-full border text-xl" :class="profile.avatar.kind === 'gallery' && profile.avatar.id === g ? 'border-amber-500 bg-amber-50 dark:bg-amber-950' : 'border-neutral-300 dark:border-neutral-700'" @click="pickAvatar(g)">
          {{ GALLERY_EMOJI[g] }}
        </button>
      </div>
      <div class="mt-2 flex items-center gap-2">
        <button class="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs dark:border-neutral-700" @click="fileInput?.click()">
          📷 Upload a photo
        </button>
        <button v-if="profile.avatar.kind === 'photo'" class="text-xs text-neutral-500 underline" @click="pickAvatar(null)">use initials instead</button>
        <input ref="fileInput" type="file" accept="image/jpeg,image/png,image/webp" class="hidden" @change="uploadPhoto" />
      </div>
    </section>

    <!-- store: try-on grid (SPEC §16) -->
    <section v-if="store" class="mt-6">
      <h2 class="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">Frames · 🪙 {{ profile.coins }}</h2>
      <div class="grid grid-cols-4 gap-3">
        <button v-for="item in store.items" :key="item.id" class="flex flex-col items-center gap-1 rounded-xl border border-neutral-200 p-2 hover:border-amber-400 dark:border-neutral-800" @click="buyOrEquip(item)">
          <UserAvatar :username="profile.username" :display-name="profile.displayName" :avatar="profile.avatar" :user-id="session.me?.id" :frame="item.asset" size="md" />
          <span class="text-center text-[10px] leading-tight">{{ item.name }}</span>
          <span class="text-[10px] font-bold" :class="profile.equipped.frame === item.id ? 'text-emerald-600' : store.owned.includes(item.id) ? 'text-sky-600' : profile.coins >= item.price ? 'text-amber-600' : 'text-neutral-400'">
            {{ profile.equipped.frame === item.id ? '✓ equipped' : store.owned.includes(item.id) ? 'equip' : `🪙 ${item.price}` }}
          </span>
        </button>
      </div>
    </section>

    <!-- passkeys -->
    <section class="mt-6">
      <h2 class="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">Passkeys</h2>
      <div v-for="pk in passkeys" :key="pk.id" class="flex items-center justify-between border-b border-neutral-100 py-2 text-sm dark:border-neutral-900">
        <span class="truncate text-neutral-500">🔑 {{ pk.id.slice(0, 16) }}…</span>
        <button class="text-xs text-red-500 underline" @click="removePasskey(pk.id)">remove</button>
      </div>
      <button class="mt-2 rounded-lg border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700" @click="addPasskey">+ Add a passkey</button>
      <p class="mt-1 text-xs text-neutral-500">There's no password reset — a passkey is your backup way in.</p>
    </section>

    <button class="mt-8 w-full rounded-lg border border-red-300 py-2 text-sm text-red-500 dark:border-red-900" @click="logout">Sign out</button>
  </div>
</template>
