import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { canAccess } from './roles';
import type { Role } from './roles';

/** Estado de carga accesible (se anuncia a lectores de pantalla). */
export function LoadingState({ label = 'Cargando…' }: { label?: string }) {
  return (
    <div className="state" role="status">
      {label}
    </div>
  );
}

/**
 * Exige sesión. Sin sesión lleva a /login y recuerda SOLO la ruta (sin query ni hash, que
 * podrían traer datos sensibles) en el `state` del router, no en la URL.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <LoadingState />;
  if (status === 'signed-out') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}

/**
 * Oculta/deniega la pantalla según el rol. Es solo comodidad de interfaz: el servidor
 * autoriza cada petición.
 */
export function RequireRole({
  roles,
  children,
}: {
  roles: readonly [Role, ...Role[]];
  children: ReactNode;
}) {
  const { user } = useAuth();
  if (!user || !canAccess(user.roles, roles)) {
    return (
      <div className="notice notice-error" role="alert">
        No tienes permiso para ver esta sección.
      </div>
    );
  }
  return <>{children}</>;
}
