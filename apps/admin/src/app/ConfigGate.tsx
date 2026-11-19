import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { loadConfig } from '../config';
import type { AppConfig } from '../config';

type ConfigState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; config: AppConfig };

/** Carga `/config.json` antes de montar la app; si falla, muestra un error claro (no un blanco). */
export function ConfigGate({ children }: { children: (config: AppConfig) => ReactNode }) {
  const [state, setState] = useState<ConfigState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    loadConfig().then(
      (config) => {
        if (!cancelled) setState({ status: 'ready', config });
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : 'No se pudo leer config.json.';
        if (!cancelled) setState({ status: 'error', message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === 'loading') {
    return (
      <div className="state" role="status">
        Cargando configuración…
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <main className="boot-error">
        <h1 className="page-title">No se pudo iniciar el panel</h1>
        <div className="notice notice-error" role="alert">
          {state.message}
        </div>
        <p>
          Verifica que exista <code>/config.json</code> con los datos del entorno (ver{' '}
          <code>config.example.json</code>) y recarga la página.
        </p>
      </main>
    );
  }
  return <>{children(state.config)}</>;
}
