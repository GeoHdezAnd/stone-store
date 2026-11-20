import type { ReactNode } from 'react';

export interface TimelineEntry {
  id: string;
  /** Fecha ya formateada. */
  when: string;
  title: ReactNode;
  detail?: ReactNode;
}

/** Línea de tiempo (lista ordenada). Presentación pura. */
export function Timeline({
  entries,
  emptyText = 'Sin movimientos.',
}: {
  entries: readonly TimelineEntry[];
  emptyText?: string;
}) {
  if (entries.length === 0) return <p className="muted">{emptyText}</p>;
  return (
    <ol className="timeline">
      {entries.map((e) => (
        <li key={e.id} className="timeline-item">
          <p className="timeline-title">{e.title}</p>
          {e.detail ? <p className="timeline-detail">{e.detail}</p> : null}
          <p className="muted timeline-when">{e.when}</p>
        </li>
      ))}
    </ol>
  );
}
