import { useCallback, useEffect, useRef } from 'react';

/**
 * Devuelve una función que dice si el componente sigue montado. Sirve para no navegar ni
 * actuar sobre la pantalla cuando una petición responde después de que la persona se fue.
 */
export function useIsMounted(): () => boolean {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true; // también tras el remonte de StrictMode
    return () => {
      mounted.current = false;
    };
  }, []);
  return useCallback(() => mounted.current, []);
}
