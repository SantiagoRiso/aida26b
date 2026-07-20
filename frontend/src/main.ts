import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { i18n } from './i18n';
import { router } from './router';
import './styles/main.css';
import { useAuthStore } from './stores/auth';
import { installGlobalErrorHandlers } from './global-errors';

const app = createApp(App);
const pinia = createPinia();

// Installed before anything can throw, so a failure during boot is recorded rather than lost.
installGlobalErrorHandlers(app);

app.use(pinia);
app.use(i18n);

// Restore session from cookie BEFORE installing the router: vue-router starts the
// initial navigation at install time, and the auth guard must see the restored user
// or a page refresh on any protected route bounces to /login despite a valid session.
// Uses entry auth-mode: a 401 (not logged in) leaves user null with NO session-expired toast.
const auth = useAuthStore();
auth.fetchMe().finally(() => {
  app.use(router);
  app.mount('#app');
});
