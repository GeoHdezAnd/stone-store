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

/**
 * Resultado de `signIn`: la sesión queda abierta solo con `signed-in`. Los otros dos son retos
 * de verificación en dos pasos que se completan con `confirmTotpSetup` o `submitTotp`.
 */
export type SignInResult =
  { status: 'signed-in' } | { status: 'mfa-setup' } | { status: 'totp-required' };

/** Datos del alta de TOTP. Viven SOLO en memoria: no se guardan ni se escriben en logs. */
export interface TotpSetupData {
  /** Clave compartida en base32 (la que se escribe a mano en la app autenticadora). */
  secret: string;
  /** Enlace `otpauth://` que codifica el QR. */
  otpauthUri: string;
}

export interface AuthService {
  /** Lee la sesión guardada (localStorage) y deja el estado en signed-in o signed-out. */
  init(): Promise<void>;
  getState(): AuthState;
  /** Referencia estable entre cambios (compatible con useSyncExternalStore). */
  subscribe(listener: () => void): () => void;
  currentUser(): AuthUser | null;
  signIn(email: string, password: string): Promise<SignInResult>;
  /** Con el reto `mfa-setup` pendiente: pide a Cognito la clave TOTP del usuario. */
  startTotpSetup(): Promise<TotpSetupData>;
  /** Con el reto `mfa-setup` pendiente: verifica el primer código y abre la sesión. */
  confirmTotpSetup(code: string): Promise<void>;
  /** Con el reto `totp-required` pendiente: verifica el código de 6 dígitos y abre la sesión. */
  submitTotp(code: string): Promise<void>;
  /** Descarta el reto pendiente (volver al login). */
  cancelChallenge(): void;
  /** Token de acceso vigente; renueva si faltan menos de 60 s. Una sola renovación a la vez. */
  getAccessToken(): Promise<string>;
  /** Fuerza una renovación (p. ej. tras un 401). Una sola a la vez. */
  refreshAccessToken(): Promise<string>;
  signOut(): Promise<void>;
  /** Vuelve a leer el almacenamiento (cambios hechos por otra pestaña). */
  syncFromStorage(): Promise<void>;
}
