import { defineStore } from 'pinia';
import { api } from '../api';

export interface Notification {
  id: number;
  type: string;
  payload: { title: string; body?: string; leagueId?: number; roundId?: number };
  read: boolean;
  createdAt: number;
}

export const useAlerts = defineStore('alerts', {
  state: () => ({
    unread: 0,
    notifications: [] as Notification[],
    timer: null as ReturnType<typeof setInterval> | null,
  }),
  actions: {
    async refresh() {
      try {
        const res = await api.get<{ unread: number; notifications: Notification[] }>('/api/notifications');
        this.unread = res.unread;
        this.notifications = res.notifications;
      } catch {
        /* signed out or offline — leave state as-is */
      }
    },
    // Lightweight polling (SPEC §4: no websockets in v1).
    startPolling() {
      if (this.timer) return;
      void this.refresh();
      this.timer = setInterval(() => void this.refresh(), 30_000);
    },
    async markAll() {
      await api.post('/api/notifications/read', { all: true });
      await this.refresh();
    },
  },
});
