import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useAuth } from './AuthContext';
import { AuthError } from './errors';
import type { TotpSetupData } from './types';

interface TotpSetupProps {
  /** Vuelve al login. Recibe un mensaje cuando el reto ya no se puede continuar. */
  onBack: (message?: string) => void;
}

/** «ABCD EFGH …»: la clave agrupada de 4 en 4 es más fácil de leer y de escribir. */
function groupSecret(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, '$1 ');
}

/**
 * Paso del login: alta de la verificación en dos pasos (TOTP). La clave vive solo en el
 * estado de este componente (memoria): no se guarda ni se escribe en consola.
 */
export function TotpSetup({ onBack }: TotpSetupProps) {
  const { startTotpSetup, confirmTotpSetup } = useAuth();
  const [setup, setSetup] = useState<TotpSetupData | null>(null);
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  // Cada llamada a Cognito genera una clave distinta y reemplaza la anterior: solo una vez
  // (React StrictMode ejecuta los efectos dos veces en desarrollo).
  const started = useRef(false);
  // StrictMode simula un desmontaje: `alive` se reactiva en cada montaje del efecto.
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    headingRef.current?.focus();
    if (started.current) return;
    started.current = true;
    startTotpSetup().then(
      (data) => {
        if (alive.current) setSetup(data);
      },
      (err: unknown) => {
        // Un fallo tardío de un reto cancelado no debe tocar el login.
        if (!alive.current) return;
        const authError = err instanceof AuthError ? err : new AuthError('unknown');
        onBack(authError.message);
      },
    );
    return () => {
      alive.current = false;
    };
  }, [startTotpSetup, onBack]);

  useEffect(() => {
    if (error) alertRef.current?.focus();
  }, [error]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await confirmTotpSetup(code);
      // La sesión quedó abierta: la página de login redirige sola.
    } catch (err) {
      const authError = err instanceof AuthError ? err : new AuthError('unknown');
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

  async function copySecret() {
    if (!setup) return;
    try {
      await navigator.clipboard.writeText(setup.secret);
      setCopied('ok');
    } catch {
      // Sin permiso o sin API: la clave sigue visible para copiarla a mano.
      setCopied('fail');
    }
  }

  return (
    <>
      <h1 className="page-title" ref={headingRef} tabIndex={-1}>
        Activa la verificación en dos pasos
      </h1>
      <p className="muted">
        Tu cuenta la exige para entrar. Solo tienes que hacerlo una vez en cada teléfono.
      </p>

      <ol className="totp-steps">
        <li>
          Instala una aplicación autenticadora en tu teléfono (por ejemplo, Google Authenticator).
        </li>
        <li>Escanea el código QR, o escribe la clave en la aplicación.</li>
        <li>Ingresa el código de 6 dígitos que te muestra la aplicación.</li>
      </ol>

      {setup ? (
        <div className="totp-setup">
          <div className="totp-qr">
            <QRCodeSVG
              value={setup.otpauthUri}
              size={192}
              marginSize={4}
              level="M"
              bgColor="#ffffff"
              fgColor="#000000"
              title="Código QR para activar la verificación en dos pasos de Canteras Naturales"
            />
          </div>

          <p className="muted">¿No puedes escanear? Escribe esta clave en tu aplicación:</p>
          <p className="totp-secret">
            <code aria-label="Clave de verificación">{groupSecret(setup.secret)}</code>
          </p>
          <button className="btn btn-secondary" type="button" onClick={() => void copySecret()}>
            Copiar clave
          </button>
          <p role="status" className="muted">
            {copied === 'ok' ? 'Clave copiada.' : null}
            {copied === 'fail' ? 'No se pudo copiar. Selecciona la clave y cópiala a mano.' : null}
          </p>
          <p className="muted">
            O abre este enlace en tu teléfono:{' '}
            <a className="totp-link" href={setup.otpauthUri}>
              {setup.otpauthUri}
            </a>
          </p>
        </div>
      ) : (
        <p role="status" className="muted">
          Preparando tu clave…
        </p>
      )}

      {error ? (
        <div ref={alertRef} className="notice notice-error" role="alert" tabIndex={-1}>
          {error}
        </div>
      ) : null}

      <form onSubmit={(e) => void onSubmit(e)} noValidate>
        <div className="field">
          <label htmlFor="totp-setup-code">Código de 6 dígitos</label>
          <input
            ref={inputRef}
            id="totp-setup-code"
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
          disabled={submitting || !setup || code.length !== 6}
        >
          {submitting ? 'Verificando…' : 'Verificar y entrar'}
        </button>
        <button
          className="btn btn-secondary btn-block"
          type="button"
          disabled={submitting}
          onClick={() => onBack()}
        >
          Cancelar
        </button>
      </form>

      <p className="muted">
        Si recargas la página, tendrás que iniciar sesión de nuevo y se generará otra clave.
      </p>
    </>
  );
}
