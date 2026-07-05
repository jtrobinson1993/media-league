<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    username: string;
    displayName?: string | null;
    avatar?: { kind: string; id?: string; color?: string } | null;
    frame?: string | null; // cosmetic asset class
    size?: 'sm' | 'md' | 'lg';
    userId?: number | null; // needed to load a photo avatar
  }>(),
  { size: 'md', avatar: null, frame: null, displayName: null, userId: null },
);

const GALLERY: Record<string, string> = {
  'slasher-mask': '🎭', robot: '🤖', alien: '👽', 'film-reel': '🎞️', vampire: '🧛', ghost: '👻',
  clown: '🤡', popcorn: '🍿', zombie: '🧟', detective: '🕵️', astronaut: '🧑‍🚀', dinosaur: '🦖',
};

const initials = computed(() =>
  (props.displayName || props.username)
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase(),
);

const bg = computed(() => {
  const c = props.avatar?.color;
  if (c && c !== 'auto') return c;
  // deterministic hue from username
  let h = 0;
  for (const ch of props.username) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `oklch(0.65 0.15 ${h})`;
});

const sizeClass = { sm: 'h-7 w-7 text-xs', md: 'h-10 w-10 text-sm', lg: 'h-20 w-20 text-2xl' };
</script>

<template>
  <div
    class="flex shrink-0 items-center justify-center rounded-full font-bold text-white"
    :class="[sizeClass[size], frame ? `ml-frame ${frame}` : '']"
    :style="{ backgroundColor: bg }"
    :title="displayName || username"
  >
    <img
      v-if="avatar?.kind === 'photo' && userId"
      :src="`/api/users/${userId}/avatar-photo`"
      class="h-full w-full rounded-full object-cover"
    />
    <span v-else-if="avatar?.kind === 'gallery' && avatar.id">{{ GALLERY[avatar.id] ?? '🎬' }}</span>
    <span v-else>{{ initials }}</span>
  </div>
</template>

<style>
/* Frame placeholder styling (CSS-only per SPEC §4); each asset key gets a ring. */
.ml-frame { box-shadow: 0 0 0 3px var(--ml-frame-color, #d4af37); }
.frame-classic-gold { --ml-frame-color: #d4af37; }
.frame-silver-screen { --ml-frame-color: #c0c0c0; }
.frame-film-strip { --ml-frame-color: #444; }
.frame-neon-marquee { --ml-frame-color: #ff2d95; }
.frame-director-clap { --ml-frame-color: #222; }
.frame-popcorn { --ml-frame-color: #f5c518; }
.frame-red-carpet { --ml-frame-color: #b3001b; }
.frame-cult-vhs { --ml-frame-color: #7f00ff; }
</style>
