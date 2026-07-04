import { createRouter, createWebHistory } from 'vue-router';
import { useSession } from './stores/session';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: () => import('./views/LoginView.vue'), meta: { public: true } },
    { path: '/join/:code', name: 'join', component: () => import('./views/JoinView.vue'), meta: { public: true } },
    { path: '/', name: 'home', component: () => import('./views/HomeView.vue') },
    { path: '/groups/:id', name: 'group', component: () => import('./views/GroupView.vue') },
    { path: '/leagues/:id', name: 'league', component: () => import('./views/LeagueView.vue') },
    { path: '/rounds/:id', name: 'round', component: () => import('./views/RoundView.vue') },
    { path: '/alerts', name: 'alerts', component: () => import('./views/AlertsView.vue') },
    { path: '/me', name: 'profile', component: () => import('./views/ProfileView.vue') },
    { path: '/users/:id', name: 'user', component: () => import('./views/UserView.vue') },
    { path: '/admin', name: 'admin', component: () => import('./views/AdminView.vue') },
  ],
});

router.beforeEach(async (to) => {
  const session = useSession();
  if (!session.loaded) await session.load();
  if (!to.meta.public && !session.me) {
    return { name: 'login', query: to.fullPath !== '/' ? { next: to.fullPath } : {} };
  }
  return true;
});
