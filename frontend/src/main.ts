import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { i18n } from './i18n';
import { router } from './router';
import './styles/main.css';

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(i18n);
app.use(router);

// Restore session from cookie before the first navigation resolves.
// Uses entry auth-mode: a 401 (not logged in) leaves user null with NO session-expired toast.
import { useAuthStore } from './stores/auth';
const auth = useAuthStore();
auth.fetchMe().finally(() => {
  app.mount('#app');
});
