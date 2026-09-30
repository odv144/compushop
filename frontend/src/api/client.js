import axios from 'axios';

const isBrowser = typeof window !== 'undefined';
const isLocalhost = isBrowser && /localhost|127\.0\.0\.1/.test(window.location.hostname);

const API_URL =
  import.meta.env.VITE_API_URL ||
  (isLocalhost ? 'http://localhost:4000/api' : 'https://compushop-backend.vercel.app/api');

const api = axios.create({
  baseURL: API_URL,
  headers: { 'Content-Type': 'application/json' },
  timeout: 20000,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('compushop_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export default api;
