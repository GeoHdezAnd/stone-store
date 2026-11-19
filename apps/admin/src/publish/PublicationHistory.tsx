import type { PublicationItem } from '../api/publishApi';
import { DataTable } from '../components/DataTable';
import type { Column } from '../components/DataTable';
import { StatusTag } from '../components/StatusTag';
import { formatDateTime, publicationLabel, shortUser } from '../lib/publishLabels';

interface PublicationHistoryProps {
  publications: readonly PublicationItem[];
  currentVersion: string | null;
  /** Si se pasa, cada fila (menos la vigente) ofrece «Revertir a esta versión». */
  onRevert?: ((version: string) => void) | undefined;
  disabled?: boolean;
}

/** Historial de versiones. Presentación pura: el padre decide qué pasa al revertir. */
export function PublicationHistory({
  publications,
  currentVersion,
  onRevert,
  disabled = false,
}: PublicationHistoryProps) {
  if (publications.length === 0) return <p className="state">Aún no hay versiones publicadas.</p>;
  const columns: Column<PublicationItem>[] = [
    { key: 'version', header: 'Versión', render: (p) => p.version },
    {
      key: 'estado',
      header: 'Estado',
      render: (p) => (
        <StatusTag
          active={p.version === currentVersion}
          activeLabel="Vigente"
          inactiveLabel="Anterior"
        />
      ),
    },
    { key: 'at', header: 'Fecha', render: (p) => formatDateTime(p.publishedAt) },
    { key: 'by', header: 'Quién', render: (p) => shortUser(p.publishedBy) },
    { key: 'action', header: 'Acción', render: (p) => publicationLabel(p.action, p.revertedFrom) },
  ];
  return (
    <DataTable
      caption="Historial de versiones publicadas"
      columns={columns}
      rows={publications}
      getRowKey={(p) => p.version}
      {...(onRevert
        ? {
            renderActions: (p: PublicationItem) =>
              p.version === currentVersion ? null : (
                <button
                  type="button"
                  className="link-btn"
                  disabled={disabled}
                  aria-label={`Revertir a la versión ${p.version}`}
                  onClick={() => onRevert(p.version)}
                >
                  Revertir a esta versión
                </button>
              ),
          }
        : {})}
    />
  );
}
