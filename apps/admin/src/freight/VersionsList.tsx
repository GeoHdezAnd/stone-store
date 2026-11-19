import type { FreightVersionSummary } from '../api/freightApi';
import { DataTable } from '../components/DataTable';
import type { Column } from '../components/DataTable';
import { shortUser, formatDateTime } from '../lib/publishLabels';

interface VersionsListProps {
  versions: readonly FreightVersionSummary[];
  /** Si se pasa, cada fila (menos la activa) ofrece «Activar esta versión». */
  onActivate?: ((version: string) => void) | undefined;
  /** Si se pasa, cada fila ofrece «Usar como base». */
  onUseAsBase?: ((version: string) => void) | undefined;
  disabled?: boolean;
}

/** Versiones de tarifas. Presentación pura: el padre decide qué hacen las acciones. */
export function VersionsList({
  versions,
  onActivate,
  onUseAsBase,
  disabled = false,
}: VersionsListProps) {
  const columns: Column<FreightVersionSummary>[] = [
    { key: 'version', header: 'Versión', render: (v) => v.version },
    { key: 'at', header: 'Fecha', render: (v) => (v.creadaAt ? formatDateTime(v.creadaAt) : '—') },
    { key: 'by', header: 'Quién', render: (v) => (v.creadaPor ? shortUser(v.creadaPor) : '—') },
    { key: 'resumen', header: 'Resumen del cambio', render: (v) => v.resumenCambio || '—' },
    {
      key: 'tags',
      header: 'Estado',
      render: (v) => (
        <span className="row-actions">
          {v.activa ? <span className="tag tag-ink">Activa</span> : null}
          {v.ejemplo ? <span className="tag tag-outline">Ejemplo</span> : null}
        </span>
      ),
    },
  ];
  const hasActions = onActivate !== undefined || onUseAsBase !== undefined;
  return (
    <DataTable
      caption="Versiones de tarifas de flete"
      columns={columns}
      rows={versions}
      getRowKey={(v) => v.version}
      {...(hasActions
        ? {
            renderActions: (v: FreightVersionSummary) => (
              <span className="row-actions">
                {onUseAsBase ? (
                  <button
                    type="button"
                    className="link-btn"
                    aria-label={`Usar la versión ${v.version} como base`}
                    onClick={() => onUseAsBase(v.version)}
                  >
                    Usar como base
                  </button>
                ) : null}
                {onActivate && !v.activa ? (
                  <button
                    type="button"
                    className="link-btn"
                    disabled={disabled}
                    aria-label={`Activar la versión ${v.version}`}
                    onClick={() => onActivate(v.version)}
                  >
                    Activar esta versión
                  </button>
                ) : null}
              </span>
            ),
          }
        : {})}
    />
  );
}
