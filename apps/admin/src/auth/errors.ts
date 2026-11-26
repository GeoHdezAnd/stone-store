export type AuthErrorCode =
  | 'invalid_credentials'
  | 'unsupported_challenge'
  | 'code_mismatch'
  | 'totp_setup_failed'
  | 'challenge_expired'
  | 'rate_limited'
  | 'network'
  | 'session_expired'
  | 'unknown';

// Mensajes genéricos: NO distinguen «usuario no existe» de «contraseña incorrecta».
const MESSAGES: Record<AuthErrorCode, string> = {
  invalid_credentials: 'El correo o la contraseña no son correctos.',
  unsupported_challenge:
    'Tu cuenta requiere un paso adicional (por ejemplo, cambiar la contraseña) que este panel todavía no soporta. Pide ayuda a quien administra la cuenta.',
  code_mismatch:
    'El código no es correcto. Revisa que el reloj de tu teléfono esté en hora y vuelve a intentarlo.',
  totp_setup_failed:
    'No pudimos activar la verificación en dos pasos. Revisa el código e inténtalo de nuevo.',
  challenge_expired: 'La sesión de verificación venció. Inicia sesión de nuevo.',
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

/**
 * Traduce un error de Cognito durante un reto de verificación en dos pasos. Aquí
 * `NotAuthorizedException` significa reto vencido, no «contraseña incorrecta». Los mensajes son genéricos y nunca incluyen texto de Cognito.
 */
export function mapChallengeError(err: unknown): AuthError {
  const name =
    typeof err === 'object' && err !== null
      ? String((err as { code?: unknown }).code ?? (err as { name?: unknown }).name ?? '')
      : '';
  switch (name) {
    // Dentro de un reto, un parámetro inválido casi siempre es un código mal formado.
    case 'CodeMismatchException':
    case 'InvalidParameterException':
      return new AuthError('code_mismatch');
    case 'EnableSoftwareTokenMFAException':
      return new AuthError('totp_setup_failed');
    // Cognito responde `NotAuthorizedException` cuando la sesión del reto venció (la
    // documentación no lo dice de forma explícita; es lo observado). Por eso el bloqueo por
    // intentos se reconoce solo por las excepciones de más abajo. Además, no está verificado
    // qué significa `ExpiredCodeException` en este flujo (podría ser un código TOTP ya usado);
    // hoy se trata como reto vencido.
    case 'ExpiredCodeException':
    case 'SessionExpiredException':
    case 'NotAuthorizedException':
      return new AuthError('challenge_expired');
    case 'TooManyRequestsException':
    case 'LimitExceededException':
    case 'TooManyFailedAttemptsException':
      return new AuthError('rate_limited');
    default:
      return mapCognitoError(err);
  }
}
