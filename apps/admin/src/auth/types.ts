import type { Role } from '@canteras/shared';

export interface AuthUser {
  email: string;
  /** Grupos tal cual vienen del token (para diagnóstico; no se usan para decidir). */
  groups: string[];
  /** Solo los grupos que son EXACTAMENTE un rol conocido. Solo sirve para mostrar/ocultar. */
  roles: Role[];
}

export type AuthState =
  { status: 'loading' } | { status: 'signed-out' } | { status: 'signed-in'; user: AuthUser };

export interface AuthService {
  /** Lee la sesión guardada (localStorage) y deja el estado en signed-in o signed-out. */
  init(): Promise<void>;
  getState(): AuthState;
  /** Referencia estable entre cambios (compatible con useSyncExternalStore). */
  subscribe(listener: () => void): () => void;
  currentUser(): AuthUser | null;
  signIn(email: string, password: string): Promise<void>;
  /** Token de acceso vigente; renueva si faltan menos de 60 s. Una sola renovación a la vez. */
  getAccessToken(): Promise<string>;
  /** Fuerza una renovación (p. ej. tras un 401). Una sola a la vez. */
  refreshAccessToken(): Promise<string>;
  signOut(): Promise<void>;
  /** Vuelve a leer el almacenamiento (cambios hechos por otra pestaña). */
  syncFromStorage(): Promise<void>;
}
