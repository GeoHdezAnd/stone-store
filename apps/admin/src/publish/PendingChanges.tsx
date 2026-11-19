import type { PendingChange } from '../api/publishApi';
import { DataTable } from '../components/DataTable';
import type { Column } from '../components/DataTable';
import { changeLabel, entityLabel, formatDateTime, shortUser } from '../lib/publishLabels';

const columns: readonly Column<PendingChange>[] = [
  { key: 'entity', header: 'Elemento', render: (c) => entityLabel(c.entity) },
  { key: 'id', header: 'Id', render: (c) => c.id },
  { key: 'accion', header: 'Cambio', render: (c) => changeLabel(c.accion) },
  { key: 'user', header: 'Quién', render: (c) => shortUser(c.userId) },
  { key: 'at', header: 'Cuándo', render: (c) => formatDateTime(c.at) },
];

/** Lista de cambios hechos desde la última publicación. Presentación pura. */
export function PendingChanges({
  items,
  truncated,
}: {
  items: readonly PendingChange[];
  truncated: boolean;
}) {
  if (items.length === 0) return <p className="state">No hay cambios pendientes.</p>;
  return (
    <>
      <DataTable
        caption="Cambios pendientes desde la última publicación"
        columns={columns}
        rows={items}
        getRowKey={(c) => `${c.entity}:${c.id}:${c.at}:${c.accion}`}
      />
      {truncated ? <p className="muted">Hay más cambios de los que se muestran aquí.</p> : null}
    </>
  );
}
