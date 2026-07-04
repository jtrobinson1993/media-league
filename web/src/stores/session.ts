import { defineStore } from 'pinia';
import { api } from '../api';

export interface Me {
  id: number;
  username: string;
  displayName: string | null;
  isOperator: boolean;
}

export const useSession = defineStore('session', {
  state: () => ({
    me: null as Me | null,
    loaded: false,
  }),
  actions: {
    async load() {
      try {
        const res = await api.get<{ user: Me }>('/api/auth/me');
        this.me = res.user;
      } catch {
        this.me = null;
      }
      this.loaded = true;
    },
    async login(username: string, password: string) {
      await api.post('/api/auth/login', { username, password });
      await this.load();
    },
    async register(username: string, password: string, displayName?: string) {
      const res = await api.post<{ recoveryNotice: string }>('/api/auth/register', {
        username,
        password,
        displayName: displayName || undefined,
      });
      await this.load();
      return res.recoveryNotice;
    },
    async logout() {
      await api.post('/api/auth/logout');
      this.me = null;
    },
  },
});
