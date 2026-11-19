import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { AuthError } from '../auth/errors';

/** Solo se acepta como destino una ruta interna simple (evita redirecciones abiertas). */
function safeDestination(state: unknown): string {
  const from = (state as { from?: unknown } | null)?.from;
  if (
    typeof from === 'string' &&
    /^\/(?![/\\])/.test(from) &&
    !from.startsWith('/login') &&
    !/[\s\\]/.test(from)
  ) {
    return from;
  }
  return '/';
}

export function LoginPage() {
  const { status, signIn } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (error) alertRef.current?.focus();
  }, [error]);

  if (status === 'signed-in') {
    return <Navigate to={safeDestination(location.state)} replace />;
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await signIn(email, password);
      navigate(safeDestination(location.state), { replace: true });
    } catch (err) {
      setPassword('');
      setError(
        err instanceof AuthError ? err.message : 'No pudimos iniciar sesión. Inténtalo de nuevo.',
      );
      setSubmitting(false);
    }
  }

  return (
    <main className="login">
      <p className="side-brand">CANTERAS NATURALES</p>
      <h1 className="page-title">Iniciar sesión</h1>
      <p className="muted">Panel del dueño</p>

      {error ? (
        <div ref={alertRef} className="notice notice-error" role="alert" tabIndex={-1}>
          {error}
        </div>
      ) : null}

      <form onSubmit={(e) => void onSubmit(e)} noValidate>
        <div className="field">
          <label htmlFor="login-email">Correo electrónico</label>
          <input
            id="login-email"
            className="input"
            type="email"
            name="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="login-password">Contraseña</label>
          <input
            id="login-password"
            className="input"
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <button className="btn btn-primary btn-block" type="submit" disabled={submitting}>
          {submitting ? 'Iniciando sesión…' : 'Iniciar sesión'}
        </button>
      </form>
    </main>
  );
}
