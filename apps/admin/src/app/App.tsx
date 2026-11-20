import { useMemo } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ApiContext, ApiDownloadContext } from '../api/ApiContext';
import { createApiClient, createApiDownloader } from '../api/client';
import { AuthProvider } from '../auth/AuthContext';
import { RequireAuth, RequireRole } from '../auth/guards';
import { createAuthService } from '../auth/service';
import { ToastProvider } from '../toast/ToastContext';
import { CatalogRoutes } from '../catalog/CatalogRoutes';
import { finishesConfig } from '../catalog/finishes';
import { projectsConfig } from '../catalog/projects';
import { servicesConfig } from '../catalog/services';
import { stonesConfig } from '../catalog/stones';
import { FreightScreen } from '../freight/FreightScreen';
import { QuoteRoutes } from '../quotes/QuoteRoutes';
import { PublishScreen } from '../publish/PublishScreen';
import { SettingsScreen } from '../settings/SettingsScreen';
import type { AppConfig } from '../config';
import { Layout } from './Layout';
import { LoginPage } from '../pages/Login';
import { NotFoundPage } from '../pages/NotFound';

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
        <Route
          path="stones/*"
          element={
            <RequireRole roles={['owner', 'staff']}>
              <CatalogRoutes config={stonesConfig} />
            </RequireRole>
          }
        />
        <Route
          path="projects/*"
          element={
            <RequireRole roles={['owner', 'staff']}>
              <CatalogRoutes config={projectsConfig} />
            </RequireRole>
          }
        />
        <Route
          path="finishes/*"
          element={
            <RequireRole roles={['owner', 'staff']}>
              <CatalogRoutes config={finishesConfig} />
            </RequireRole>
          }
        />
        <Route
          path="services/*"
          element={
            <RequireRole roles={['owner', 'staff']}>
              <CatalogRoutes config={servicesConfig} />
            </RequireRole>
          }
        />
        <Route
          path="quotes/*"
          element={
            <RequireRole roles={['owner', 'staff']}>
              <QuoteRoutes />
            </RequireRole>
          }
        />
        <Route
          path="freight"
          element={
            <RequireRole roles={['owner', 'staff']}>
              <FreightScreen />
            </RequireRole>
          }
        />
        <Route
          path="publish"
          element={
            <RequireRole roles={['owner', 'staff']}>
              <PublishScreen />
            </RequireRole>
          }
        />
        <Route
          path="settings"
          element={
            <RequireRole roles={['owner', 'staff']}>
              <SettingsScreen />
            </RequireRole>
          }
        />
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
  const download = useMemo(
    () => createApiDownloader({ apiUrl: config.apiUrl, auth }),
    [config.apiUrl, auth],
  );
  return (
    <AuthProvider service={auth}>
      <ApiContext.Provider value={apiFetch}>
        <ApiDownloadContext.Provider value={download}>
          <ToastProvider>
            <BrowserRouter>
              <AppRoutes />
            </BrowserRouter>
          </ToastProvider>
        </ApiDownloadContext.Provider>
      </ApiContext.Provider>
    </AuthProvider>
  );
}
