import './styles.css';
import { createCloud } from './lib/cloud';
import { mountTextDrop } from './app';

const url = import.meta.env.VITE_SUPABASE_URL ?? '';
const key = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';
mountTextDrop(document.querySelector<HTMLDivElement>('#app')!, createCloud(url, key), {
  configured: Boolean(url && key),
  version: __APP_VERSION__,
});
