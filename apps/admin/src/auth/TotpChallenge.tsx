import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from './AuthContext';
import { AuthError } from './errors';

interface TotpChallengeProps {
  /** Vuelve al login. Recibe un mensaje cuando el reto ya no se puede continuar. */
  onBack: (message?: string) => void;
}

/** Paso del login: pide el código de 6 dígitos de la app autenticadora. */
export function TotpChallenge({ onBack }: TotpChallengeProps) {
  const { submitTotp } = useAuth();
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (error) alertRef.current?.focus();
  }, [error]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await submitTotp(code);
      // La sesión quedó abierta: la página de login redirige sola.
    } catch (err) {
      const authError = err instanceof AuthError ? err : new AuthError('unknown');
      // Reto vencido, bloqueado o sin reto pendiente: no tiene caso seguir aquí.
      if (authError.code === 'challenge_expired' || authError.code === 'rate_limited') {
        onBack(authError.message);
        return;
      }
      setCode('');
      setError(authError.message);
      setSubmitting(false);
      inputRef.current?.focus();
    }
  }

  return (
    <>
      <h1 className="page-title">Verificación en dos pasos</h1>
      <p className="muted">
        Abre tu aplicación autenticadora e ingresa el código de 6 dígitos de Canteras Naturales.
      </p>

      {error ? (
        <div ref={alertRef} className="notice notice-error" role="alert" tabIndex={-1}>
          {error}
        </div>
      ) : null}

      <form onSubmit={(e) => void onSubmit(e)} noValidate>
        <div className="field">
          <label htmlFor="totp-code">Código de 6 dígitos</label>
          <input
            ref={inputRef}
            id="totp-code"
            className="input"
            type="text"
            name="totp"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            required
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          />
        </div>
        <button
          className="btn btn-primary btn-block"
          type="submit"
          disabled={submitting || code.length !== 6}
        >
          {submitting ? 'Verificando…' : 'Verificar'}
        </button>
        <button
          className="btn btn-secondary btn-block"
          type="button"
          disabled={submitting}
          onClick={() => onBack()}
        >
          Volver
        </button>
      </form>
    </>
  );
}
