import type { CurrentPublication } from '../api/publishApi';
import { formatDateTime, publicationLabel, shortUser } from '../lib/publishLabels';

/** Versión vigente del sitio. Presentación pura. */
export function CurrentVersionCard({ current }: { current: CurrentPublication | null }) {
  if (current === null) {
    return <p className="state">Todavía no se ha publicado el catálogo.</p>;
  }
  return (
    <dl className="publish-card">
      <div>
        <dt>Versión</dt>
        <dd className="big">{current.version}</dd>
      </div>
      <div>
        <dt>Publicada</dt>
        <dd>{formatDateTime(current.publishedAt)}</dd>
      </div>
      <div>
        <dt>Por</dt>
        <dd>{shortUser(current.publishedBy)}</dd>
      </div>
      <div>
        <dt>Acción</dt>
        <dd>{publicationLabel(current.action)}</dd>
      </div>
    </dl>
  );
}
