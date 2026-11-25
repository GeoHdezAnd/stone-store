import type { MetricsResponse } from '@canteras/shared';
import { Link } from 'react-router-dom';
import { DataTable, type Column } from '../components/DataTable';
import { Tag } from '../components/Tag';
import { STATUS_TONES, ageLabel, statusLabel } from '../lib/quoteLabels';

type Funnel = MetricsResponse['funnel'][number];
type Zone = MetricsResponse['zones'][number];
type Waiting = MetricsResponse['waiting']['items'][number];

const funnelColumns: readonly Column<Funnel>[] = [
  { key: 'etapa', header: 'Etapa', render: (f) => f.label },
  { key: 'total', header: 'Solicitudes', numeric: true, render: (f) => f.count },
];

const zoneColumns: readonly Column<Zone>[] = [
  { key: 'estado', header: 'Estado', render: (z) => z.estado },
  { key: 'total', header: 'Solicitudes', numeric: true, render: (z) => z.count },
];

const waitingColumns: readonly Column<Waiting>[] = [
  {
    key: 'folio',
    header: 'Folio',
    render: (r) => (
      <Link className="link-btn" to={`/quotes/${r.quoteId}`}>
        {r.folio}
      </Link>
    ),
  },
  {
    key: 'estado',
    header: 'Estado',
    render: (r) => <Tag tone={STATUS_TONES[r.status]}>{statusLabel(r.status)}</Tag>,
  },
  { key: 'cliente', header: 'Cliente', render: (r) => r.cliente },
  { key: 'obra', header: 'Obra', render: (r) => r.lugar },
  {
    key: 'hace',
    header: 'Hace',
    render: (r) => (
      <span className="row-actions">
        {ageLabel(r.createdAt)}
        {r.overdue ? <Tag tone="accent">Más de 48 h sin responder</Tag> : null}
      </span>
    ),
  },
];

export function FunnelTable({ funnel }: { funnel: MetricsResponse['funnel'] }) {
  return (
    <DataTable
      caption="Embudo del mes: solicitudes por etapa"
      columns={funnelColumns}
      rows={funnel}
      getRowKey={(f) => f.stage}
    />
  );
}

export function ZonesTable({ zones }: { zones: MetricsResponse['zones'] }) {
  if (zones.length === 0) {
    return <p className="muted">Aún no hay solicitudes en los últimos 30 días.</p>;
  }
  return (
    <DataTable
      caption="Solicitudes por zona, últimos 30 días"
      columns={zoneColumns}
      rows={zones}
      getRowKey={(z) => z.estado}
    />
  );
}

export function WaitingTable({ waiting }: { waiting: MetricsResponse['waiting'] }) {
  if (waiting.total === 0) {
    return <p className="muted">No hay solicitudes esperando respuesta.</p>;
  }
  return (
    <>
      <DataTable
        caption="Solicitudes nuevas, en revisión o cotizadas sin enviar, de la más antigua a la más reciente"
        columns={waitingColumns}
        rows={waiting.items}
        getRowKey={(r) => r.quoteId}
      />
      {waiting.total > waiting.items.length ? (
        <p className="muted">
          Se muestran las {waiting.items.length} más antiguas de {waiting.total}.{' '}
          <Link className="link-btn" to="/quotes">
            Ver todas las solicitudes
          </Link>
        </p>
      ) : null}
    </>
  );
}
