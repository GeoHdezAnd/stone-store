import { useAuth } from '../auth/AuthContext';

/**
 * Permisos para mostrar u ocultar controles. Quien autoriza de verdad es la API (403).
 * Único lugar donde la UI traduce roles a capacidades.
 */
export function usePermissions() {
  const { user } = useAuth();
  const isOwner = user?.roles.includes('owner') ?? false;
  return { canDeactivate: isOwner, canChangeActive: isOwner, canEditSettings: isOwner };
}
