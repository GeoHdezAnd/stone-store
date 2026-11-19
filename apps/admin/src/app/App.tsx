import { useMemo } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ApiContext } from '../api/ApiContext';
import { createApiClient } from '../api/client';
import { AuthProvider } from '../auth/AuthContext';
import { RequireAuth, RequireRole } from '../auth/guards';
import { createAuthService } from '../auth/service';
import type { AppConfig } from '../config';
import { Layout } from './Layout';
import { LoginPage } from '../pages/Login';
import { NotFoundPage } from '../pages/NotFound';
import { PlaceholderPage } from '../pages/Placeholder';

function Screen({ title }: { title: string }) {
  return (
    <RequireRole roles={['owner', 'staff']}>
      <PlaceholderPage title={title} />
    </RequireRole>
  );
}

/** Rutas de la app (sin router ni proveedores: así se prueban con MemoryRouter). */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="/stones" replace />} />
        <Route path="stones" element={<Screen title="Piedras" />} />
        <Route path="projects" element={<Screen title="Proyectos" />} />
        <Route path="finishes" element={<Screen title="Acabados" />} />
        <Route path="services" element={<Screen title="Servicios" />} />
        <Route path="settings" element={<Screen title="Configuración" />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export function App({ config }: { config: AppConfig }) {
  const auth = useMemo(() => createAuthService(config), [config]);
  const apiFetch = useMemo(
    () => createApiClient({ apiUrl: config.apiUrl, auth }),
    [config.apiUrl, auth],
  );
  return (
    <AuthProvider service={auth}>
      <ApiContext.Provider value={apiFetch}>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </ApiContext.Provider>
    </AuthProvider>
  );
}
