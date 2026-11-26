import type { HistoryEntry, Quote } from '@canteras/shared';
import { DataTable } from '../components/DataTable';
import type { Column } from '../components/DataTable';
import { KeyValueList } from '../components/KeyValueList';
import { Tag } from '../components/Tag';
import { Timeline } from '../components/Timeline';
import type { TimelineEntry } from '../components/Timeline';
import { formatNumber, unitLabel } from '../lib/freightLabels';
import { formatDateTime, shortUser } from '../lib/publishLabels';
import { formatMxn, ivaPctLabel, lostReasonLabel, statusLabel } from '../lib/quoteLabels';

/** Cliente y obra. Teléfono y correo son enlaces (tel: y mailto:). */
export function ClientBlock({ quote }: { quote: Quote }) {
  const { customer, works } = quote;
  const tel = customer.telefono.replace(/[^\d+]/g, '');
  return (
    <KeyValueList
      items={[
        { label: 'Nombre', value: customer.nombre },
        { label: 'Teléfono', value: <a href={`tel:${tel}`}>{customer.telefono}</a> },
        { label: 'Correo', value: <a href={`mailto:${customer.correo}`}>{customer.correo}</a> },
        { label: 'Lugar de la obra', value: works.lugar },
        { label: 'Código postal', value: works.codigoPostal },
        { label: 'Uso', value: works.uso || '—' },
        { label: 'Notas del cliente', value: works.notas || '—' },
        { label: 'Aviso de privacidad', value: `Aceptado el ${formatDateTime(quote.consentAt)}` },
      ]}
    />
  );
}

const stoneColumns: readonly Column<Quote['items'][number]>[] = [
  { key: 'nombre', header: 'Piedra', render: (i) => i.nombre },
  { key: 'acabado', header: 'Acabado', render: (i) => i.acabado || '—' },
  {
    key: 'cantidad',
    header: 'Cantidad',
    numeric: true,
    render: (i) => `${formatNumber(i.cantidad)} ${unitLabel(i.unidad)}`,
  },
  { key: 'peso', header: 'Peso', numeric: true, render: (i) => `${formatNumber(i.pesoKg)} kg` },
];

export function StonesBlock({ items }: { items: Quote['items'] }) {
  return (
    <DataTable
      caption="Piedras solicitadas"
      columns={stoneColumns}
      rows={items}
      getRowKey={(i) => i.stoneId}
    />
  );
}

/** Estimado automático de flete (snapshot de cuando se creó la solicitud). */
export function FreightBlock({ quote }: { quote: Quote }) {
  const f = quote.freight;
  if (!f) return <p className="muted">Esta solicitud no trae estimado de flete.</p>;
  return (
    <>
      {quote.ejemplo ? <Tag>Datos de ejemplo</Tag> : null}
      <KeyValueList
        items={[
          { label: 'Estimado', value: `${formatMxn(f.estimadoMin)} – ${formatMxn(f.estimadoMax)}` },
          { label: 'Peso total', value: `${formatNumber(f.pesoTotalKg)} kg` },
          { label: 'Distancia', value: `${formatNumber(f.distanciaKm)} km` },
          { label: 'Camión', value: f.camion },
          { label: 'Viajes', value: f.viajes },
          { label: 'Versión de tarifa', value: f.versionTarifa },
        ]}
      />
      <p className="muted">Estimado sujeto a confirmación.</p>
    </>
  );
}

/** Cotización final tal como la guardó el servidor (solo lectura). */
export function FinalQuoteSummary({ quote }: { quote: Quote }) {
  const fq = quote.finalQuote;
  if (!fq) return <p className="muted">Todavía no hay cotización final.</p>;
  return (
    <KeyValueList
      items={[
        { label: 'Piedra', value: formatMxn(fq.subtotal) },
        {
          label: fq.ivaPct === null ? 'IVA' : `IVA (${ivaPctLabel(fq.ivaPct)})`,
          value: fq.iva === null ? 'Sin IVA' : formatMxn(fq.iva),
        },
        { label: 'Flete final (sin IVA)', value: formatMxn(fq.fleteFinal) },
        { label: 'Total', value: formatMxn(fq.total) },
        { label: 'Vigencia', value: `${fq.vigenciaDias} días` },
        ...(fq.enviadaAt ? [{ label: 'Enviada', value: formatDateTime(fq.enviadaAt) }] : []),
      ]}
    />
  );
}

function historyTitle(e: HistoryEntry): string {
  switch (e.tipo) {
    case 'estado':
      return `${e.de ? statusLabel(e.de) : '—'} → ${e.a ? statusLabel(e.a) : '—'}`;
    case 'correo':
      return 'Correo enviado';
    case 'nota':
      return 'Nota interna';
    default:
      return 'Edición';
  }
}

/** El historial guarda «Motivo: <código>»: se muestra la etiqueta en español. */
function historyDetail(e: HistoryEntry): string | undefined {
  return e.texto?.replace(
    /^Motivo: (\w+)$/,
    (_m, code: string) => `Motivo: ${lostReasonLabel(code)}`,
  );
}

export function historyEntries(history: readonly HistoryEntry[]): TimelineEntry[] {
  return [...history].reverse().map((e, i) => {
    const detail = historyDetail(e);
    return {
      id: `${e.at}-${i}`,
      when: `${formatDateTime(e.at)} · ${shortUser(e.by)}`,
      title: historyTitle(e),
      ...(detail ? { detail } : {}),
    };
  });
}

export function HistoryBlock({ history }: { history: readonly HistoryEntry[] }) {
  return <Timeline entries={historyEntries(history)} emptyText="Sin movimientos todavía." />;
}
