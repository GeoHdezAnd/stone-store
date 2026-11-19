export type AuthErrorCode =
  | 'invalid_credentials'
  | 'unsupported_challenge'
  | 'rate_limited'
  | 'network'
  | 'session_expired'
  | 'unknown';

// Mensajes genéricos: NO distinguen «usuario no existe» de «contraseña incorrecta».
const MESSAGES: Record<AuthErrorCode, string> = {
  invalid_credentials: 'El correo o la contraseña no son correctos.',
  unsupported_challenge:
    'Tu cuenta requiere un paso adicional (cambio de contraseña o verificación en dos pasos) que todavía no está soportado en este panel.',
  rate_limited: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.',
  network: 'No pudimos conectarnos. Revisa tu conexión e inténtalo de nuevo.',
  session_expired: 'Tu sesión expiró. Inicia sesión de nuevo.',
  unknown: 'No pudimos iniciar sesión. Inténtalo de nuevo.',
};

/** Error de autenticación con mensaje en español; nunca contiene tokens ni texto de Cognito. */
export class AuthError extends Error {
  readonly code: AuthErrorCode;
  constructor(code: AuthErrorCode) {
    super(MESSAGES[code]);
    this.name = 'AuthError';
    this.code = code;
  }
}

/** Traduce un error de Cognito a un `AuthError` genérico. */
export function mapCognitoError(err: unknown): AuthError {
  const name =
    typeof err === 'object' && err !== null
      ? String((err as { code?: unknown }).code ?? (err as { name?: unknown }).name ?? '')
      : '';
  switch (name) {
    // Cualquier fallo de credenciales o de estado de la cuenta se ve igual desde fuera.
    case 'NotAuthorizedException':
    case 'UserNotFoundException':
    case 'UserNotConfirmedException':
    case 'PasswordResetRequiredException':
    case 'InvalidParameterException':
      return new AuthError('invalid_credentials');
    case 'TooManyRequestsException':
    case 'LimitExceededException':
    case 'TooManyFailedAttemptsException':
      return new AuthError('rate_limited');
    case 'NetworkError':
      return new AuthError('network');
    default:
      return err instanceof TypeError ? new AuthError('network') : new AuthError('unknown');
  }
}
