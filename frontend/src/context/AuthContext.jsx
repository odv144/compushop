import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api from '../api/client';

const AuthContext = createContext(null);

const TOKEN_KEY = 'compushop_token';
const USER_KEY = 'compushop_user';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const clearSession = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setUser(null);
  }, []);

  // Restaurar sesión JWT al cargar
  useEffect(() => {
    const token = localStorage.getItem(TOKEN_KEY);
    const saved = localStorage.getItem(USER_KEY);

    if (!token || !saved) {
      setLoading(false);
      return;
    }

    try {
      setUser(JSON.parse(saved));
    } catch {
      clearSession();
      setLoading(false);
      return;
    }

    // Validar token con el backend
    api
      .get('/auth/me')
      .then((r) => {
        setUser(r.data.user);
        localStorage.setItem(USER_KEY, JSON.stringify(r.data.user));
      })
      .catch(() => {
        clearSession();
      })
      .finally(() => setLoading(false));
  }, [clearSession]);

  // Si algún request devuelve 401, limpiar sesión (excepto en login/register)
  useEffect(() => {
    const id = api.interceptors.response.use(
      (res) => res,
      (error) => {
        const url = error.config?.url || '';
        const isAuthEndpoint = url.includes('/auth/login') || url.includes('/auth/register');
        if (error.response?.status === 401 && !isAuthEndpoint) {
          clearSession();
        }
        return Promise.reject(error);
      }
    );
    return () => api.interceptors.response.eject(id);
  }, [clearSession]);

  const login = async (email, password) => {
    const { data } = await api.post('/auth/login', { email, password });
    if (!data.token || !data.user) {
      throw new Error('Respuesta inválida del servidor');
    }
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(USER_KEY, JSON.stringify(data.user));
    setUser(data.user);
    return data;
  };

  const register = async (payload) => {
    const { data } = await api.post('/auth/register', payload);
    if (!data.token || !data.user) {
      throw new Error('Respuesta inválida del servidor');
    }
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(USER_KEY, JSON.stringify(data.user));
    setUser(data.user);
    return data;
  };

  const logout = () => {
    clearSession();
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        login,
        register,
        logout,
        isAdmin: user?.role === 'admin',
        isAuthenticated: !!user,
        token: typeof window !== 'undefined' ? localStorage.getItem(TOKEN_KEY) : null,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth debe usarse dentro de AuthProvider');
  return ctx;
};
