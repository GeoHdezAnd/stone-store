import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { AuthService, AuthState, AuthUser } from './types';

interface AuthContextValue {
  status: AuthState['status'];
  user: AuthUser | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ service, children }: { service: AuthService; children: ReactNode }) {
  const state = useSyncExternalStore(service.subscribe, service.getState, service.getState);

  useEffect(() => {
    void service.init();
    // Otra pestaña inició o cerró sesión: el almacenamiento cambió.
    const onStorage = () => {
      void service.syncFromStorage();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [service]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status: state.status,
      user: state.status === 'signed-in' ? state.user : null,
      signIn: (email, password) => service.signIn(email, password),
      signOut: () => service.signOut(),
    }),
    [state, service],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth debe usarse dentro de <AuthProvider>.');
  return ctx;
}
