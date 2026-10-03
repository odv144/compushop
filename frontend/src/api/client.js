import axios from 'axios';

const isBrowser = typeof window !== 'undefined';
const isLocalhost = isBrowser && /localhost|127\.0\.0\.1/.test(window.location.hostname);

// Fallback de produccion: tiene que apuntar SIEMPRE al backend canonico
// (compushop-ruby.vercel.app, PostgreSQL).
// compushop-backend.vercel.app es un deployment VIEJO con data.json: en Vercel el
// disco es read-only, asi que escribir un producto tira EROFS. Como VITE_API_URL se
// incrusta en el bundle, si falta la env var el front cae aqui EN SILENCIO: por eso
// el destino hardcodeado es una bomba de tiempo.
// Si cambias de deployment: actualizar ACA y la env var de Vercel (que exige rebuild).
const API_URL =
  import.meta.env.VITE_API_URL ||
  (isLocalhost ? 'http://localhost:4000/api' : 'https://compushop-ruby.vercel.app/api');

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
