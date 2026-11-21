import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  type CognitoUserSession,
} from 'amazon-cognito-identity-js';
import { parseGroupsClaim } from '@canteras/shared';
import { AuthError, mapCognitoError } from './errors';
import { rolesFromClaim } from './roles';
import type { AuthService, AuthState, AuthUser } from './types';

export interface AuthConfig {
  userPoolId: string;
  userPoolClientId: string;
  region: string;
  /** URL absoluta de Cognito (solo desarrollo/emulador). */
  cognitoEndpoint?: string | undefined;
}

/** Renovamos si al token de acceso le quedan menos de estos segundos. */
const REFRESH_MARGIN_SECONDS = 60;
/** Tope de espera de `globalSignOut`: el cierre local no debe depender de la red. */
const GLOBAL_SIGN_OUT_TIMEOUT_MS = 5000;

const SIGNED_OUT: AuthState = { status: 'signed-out' };

function sessionOf(user: CognitoUser): Promise<CognitoUserSession> {
  return new Promise((resolve, reject) => {
    user.getSession((err: Error | null, session: CognitoUserSession | null) => {
      if (err || !session) reject(err ?? new Error('sin sesión'));
      else resolve(session);
    });
  });
}

function userFromSession(session: CognitoUserSession): AuthUser {
  const access = session.getAccessToken().payload as Record<string, unknown>;
  const id = session.getIdToken().payload as Record<string, unknown>;
  const rawGroups = access['cognito:groups'] ?? id['cognito:groups'];
  const email = id['email'] ?? access['username'];
  return {
    email: typeof email === 'string' ? email : '',
    groups: parseGroupsClaim(rawGroups),
    roles: rolesFromClaim(rawGroups),
  };
}

function sameUser(a: AuthUser, b: AuthUser): boolean {
  return a.email === b.email && a.groups.join(' ') === b.groups.join(' ');
}

/**
 * Sesión del navegador con `amazon-cognito-identity-js` (SRP) y su almacenamiento por defecto
 * (localStorage; decisión del dueño). Nunca escribe tokens en consola, URL ni mensajes de error.
 */
export function createAuthService(config: AuthConfig): AuthService {
  const pool = new CognitoUserPool({
    UserPoolId: config.userPoolId,
    ClientId: config.userPoolClientId,
    ...(config.cognitoEndpoint !== undefined ? { endpoint: config.cognitoEndpoint } : {}),
  });
  const storagePrefix = `CognitoIdentityServiceProvider.${config.userPoolClientId}.`;

  let state: AuthState = { status: 'loading' };
  const listeners = new Set<() => void>();

  function setState(next: AuthState): void {
    if (
      state.status === next.status &&
      (state.status !== 'signed-in' ||
        (next.status === 'signed-in' && sameUser(state.user, next.user)))
    ) {
      return;
    }
    state = next;
    listeners.forEach((l) => l());
  }

  /** Borra TODO rastro local de la sesión (nunca falla). */
  function clearLocal(user: CognitoUser | null): void {
    try {
      user?.signOut();
    } catch {
      /* se sigue limpiando */
    }
    try {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i);
        if (k?.startsWith(storagePrefix)) keys.push(k);
      }
      keys.forEach((k) => localStorage.removeItem(k));
    } catch {
      /* almacenamiento no disponible */
    }
  }

  // Generación de la sesión: signOut y signOutLocal la incrementan. Una renovación que
  // empezó antes y termina después NO puede resucitar la sesión (la librería real escribe los
  // tokens en localStorage al llegar la respuesta, sin comprobar nada).
  let epoch = 0;

  function signOutLocal(): void {
    epoch += 1;
    clearLocal(pool.getCurrentUser());
    setState(SIGNED_OUT);
  }

  /** Falla de una operación asíncrona: si la sesión se cerró mientras tanto, solo se re-limpia. */
  function failOperation(startEpoch: number, user: CognitoUser): AuthError {
    if (epoch !== startEpoch) clearLocal(user);
    else signOutLocal();
    return new AuthError('session_expired');
  }

  async function readStoredSession(): Promise<void> {
    const user = pool.getCurrentUser();
    if (!user) {
      setState(SIGNED_OUT);
      return;
    }
    try {
      const session = await sessionOf(user);
      setState({ status: 'signed-in', user: userFromSession(session) });
    } catch {
      clearLocal(user);
      setState(SIGNED_OUT);
    }
  }

  async function doRefresh(): Promise<string> {
    const e = epoch;
    const user = pool.getCurrentUser();
    if (!user) {
      setState(SIGNED_OUT);
      throw new AuthError('session_expired');
    }
    let next: CognitoUserSession;
    try {
      const current = await sessionOf(user);
      if (epoch !== e) throw new Error('sesión cerrada');
      next = await new Promise<CognitoUserSession>((resolve, reject) => {
        user.refreshSession(
          current.getRefreshToken(),
          (err: Error | null, s: CognitoUserSession | null) => {
            if (err || !s) reject(err ?? new Error('sin sesión'));
            else resolve(s);
          },
        );
      });
    } catch {
      // La sesión ya no se puede renovar: se cierra localmente (sin llamadas de red).
      throw failOperation(e, user);
    }
    if (epoch !== e) {
      // Se cerró la sesión mientras renovaba: borrar lo que la librería acaba de escribir.
      clearLocal(user);
      throw new AuthError('session_expired');
    }
    setState({ status: 'signed-in', user: userFromSession(next) });
    return next.getAccessToken().getJwtToken();
  }

  async function doGetAccessToken(): Promise<string> {
    const e = epoch;
    const user = pool.getCurrentUser();
    if (!user) {
      setState(SIGNED_OUT);
      throw new AuthError('session_expired');
    }
    let session: CognitoUserSession;
    try {
      session = await sessionOf(user);
    } catch {
      throw failOperation(e, user);
    }
    if (epoch !== e) {
      // `getSession` puede haber renovado y escrito tokens después del cierre.
      clearLocal(user);
      throw new AuthError('session_expired');
    }
    const remaining = session.getAccessToken().getExpiration() - Date.now() / 1000;
    if (remaining < REFRESH_MARGIN_SECONDS) return doRefresh();
    return session.getAccessToken().getJwtToken();
  }

  // Single-flight: las llamadas simultáneas comparten UNA sola operación.
  let inflightGet: Promise<string> | null = null;
  let inflightRefresh: Promise<string> | null = null;

  return {
    async init() {
      await readStoredSession();
    },

    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    currentUser: () => (state.status === 'signed-in' ? state.user : null),

    async signIn(email, password) {
      const username = email.trim().toLowerCase();
      const user = new CognitoUser({ Username: username, Pool: pool });
      const details = new AuthenticationDetails({ Username: username, Password: password });
      const session = await new Promise<CognitoUserSession>((resolve, reject) => {
        const unsupported = () => reject(new AuthError('unsupported_challenge'));
        user.authenticateUser(details, {
          onSuccess: resolve,
          onFailure: (err: unknown) => reject(mapCognitoError(err)),
          newPasswordRequired: unsupported,
          mfaRequired: unsupported,
          totpRequired: unsupported,
          mfaSetup: unsupported,
          selectMFAType: unsupported,
          customChallenge: unsupported,
        });
      });
      setState({ status: 'signed-in', user: userFromSession(session) });
    },

    getAccessToken() {
      inflightGet ??= doGetAccessToken().finally(() => {
        inflightGet = null;
      });
      return inflightGet;
    },

    refreshAccessToken() {
      inflightRefresh ??= doRefresh().finally(() => {
        inflightRefresh = null;
      });
      return inflightRefresh;
    },

    async signOut() {
      epoch += 1; // invalida las renovaciones en vuelo desde ya
      const user = pool.getCurrentUser();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, GLOBAL_SIGN_OUT_TIMEOUT_MS);
        });
        if (user) {
          await sessionOf(user); // globalSignOut necesita la sesión cargada
          await Promise.race([
            new Promise<void>((resolve) => {
              user.globalSignOut({ onSuccess: () => resolve(), onFailure: () => resolve() });
            }),
            timeout,
          ]);
        }
        // Espera a que termine lo que esté en vuelo (con el mismo tope) para que la limpieza
        // final sea lo ÚLTIMO que ocurre.
        const pending = [inflightGet, inflightRefresh].filter((p) => p !== null);
        await Promise.race([Promise.allSettled(pending), timeout]);
      } catch {
        /* best-effort: lo importante es la limpieza local */
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        // Segundo incremento: una operación que EMPEZÓ durante el cierre (la UI sigue montada
        // hasta 5 s) tomó el epoch del primer incremento y no estaba en `pending`; sin esto
        // terminaría después de la limpieza y resucitaría la sesión.
        epoch += 1;
        clearLocal(user);
        setState(SIGNED_OUT);
      }
    },

    async syncFromStorage() {
      if (!pool.getCurrentUser()) {
        if (state.status !== 'signed-out') setState(SIGNED_OUT);
        return;
      }
      // Hay usuario guardado: se relee SIEMPRE (otra pestaña pudo dejar a OTRO usuario).
      // `setState` descarta los cambios sin efecto, así que sin cambio real no hay re-render.
      await readStoredSession();
    },
  };
}
