import { useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

const ACTIVE_ITEMS = [
  { to: '/stones', label: 'Piedras' },
  { to: '/projects', label: 'Proyectos' },
  { to: '/finishes', label: 'Acabados' },
  { to: '/services', label: 'Servicios' },
  { to: '/settings', label: 'Configuración' },
] as const;

// Pantallas de fases posteriores (3 y 6): visibles pero desactivadas.
const FUTURE_ITEMS = ['Resumen', 'Solicitudes', 'Flete y tarifas', 'Publicar'] as const;

function roleLabel(roles: readonly string[]): string {
  if (roles.includes('owner')) return 'Dueño';
  if (roles.includes('staff')) return 'Personal';
  return 'Sin rol';
}

export function Layout() {
  const { user, signOut } = useAuth();
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const firstRender = useRef(true);
  const [menuOpen, setMenuOpen] = useState(false);

  // Al cambiar de pantalla, el foco pasa al contenido (lectores de pantalla y teclado).
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    mainRef.current?.focus();
  }, [location.pathname]);

  // En pantallas angostas el menú se pliega: se cierra al navegar y con Escape.
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        toggleRef.current?.focus(); // el foco vuelve al botón que abrió el menú
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [menuOpen]);

  function skipToContent(e: MouseEvent<HTMLAnchorElement>) {
    e.preventDefault();
    mainRef.current?.focus();
  }

  return (
    <>
      <a className="skip-link" href="#contenido" onClick={skipToContent}>
        Ir al contenido
      </a>
      <div className="shell">
        <aside className="side" data-open={menuOpen}>
          <div className="side-bar">
            <div>
              <p className="side-brand">CANTERAS NATURALES</p>
              <p className="muted">Panel del dueño</p>
            </div>
            <button
              type="button"
              ref={toggleRef}
              className="side-toggle"
              aria-expanded={menuOpen}
              aria-controls="side-panel"
              aria-label={menuOpen ? 'Cerrar menú' : 'Abrir menú'}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                <path
                  d={menuOpen ? 'M4 4l12 12M16 4L4 16' : 'M3 5h14M3 10h14M3 15h14'}
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="square"
                  fill="none"
                />
              </svg>
            </button>
          </div>

          <div className="side-panel" id="side-panel">
            <nav aria-label="Secciones del panel">
              {ACTIVE_ITEMS.map((item) => (
                <NavLink key={item.to} to={item.to} className="nav-btn">
                  {item.label}
                </NavLink>
              ))}
              {FUTURE_ITEMS.map((label) => (
                // Sin href: no es navegable ni entra en el orden de tabulación. Se conserva en el
                // árbol de accesibilidad como enlace desactivado y con el aviso «Próximamente».
                <a key={label} className="nav-btn" role="link" aria-disabled="true">
                  <span>{label}</span>
                  <small>Próximamente</small>
                </a>
              ))}
            </nav>

            <div className="side-user">
              <p>{user?.email}</p>
              <p className="muted">{user ? roleLabel(user.roles) : ''}</p>
              <button type="button" className="btn btn-secondary" onClick={() => void signOut()}>
                Cerrar sesión
              </button>
            </div>
          </div>
        </aside>
        <main className="main" id="contenido" tabIndex={-1} ref={mainRef}>
          <Outlet />
        </main>
      </div>
    </>
  );
}
