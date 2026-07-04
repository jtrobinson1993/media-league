import { createRouter, createWebHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: () => import('./views/HomeView.vue') },
    { path: '/alerts', name: 'alerts', component: () => import('./views/AlertsView.vue') },
    { path: '/me', name: 'profile', component: () => import('./views/ProfileView.vue') },
  ],
});
