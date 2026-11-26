import type { IvaPct } from '@canteras/shared';
import { useEffect, useMemo, useState } from 'react';
import { useApi } from '../api/ApiContext';
import { createSettingsApi } from '../api/settingsApi';

/**
 * IVA por defecto de Settings (fila QUOTING). Solo preselecciona el formulario de la primera
 * cotización: si no carga, se queda en «sin IVA» y la cotización sigue funcionando.
 */
export function useIvaDefault(): IvaPct {
  const apiFetch = useApi();
  const api = useMemo(() => createSettingsApi(apiFetch), [apiFetch]);
  const [value, setValue] = useState<IvaPct>(null);
  useEffect(() => {
    let alive = true;
    api.get().then(
      (s) => {
        if (alive) setValue(s.quoting.ivaPctDefault);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api]);
  return value;
}
