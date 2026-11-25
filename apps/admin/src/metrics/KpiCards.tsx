import type { MetricsResponse } from '@canteras/shared';
import { formatMxn } from '../lib/quoteLabels';

type Cards = MetricsResponse['cards'];

interface Kpi {
  key: string;
  label: string;
  value: string;
  notes: string[];
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function amountNotes(prefix: string, card: Cards['quoted']): string[] {
  const notes = [`${prefix}: ${formatMxn(card.value)} (sin IVA)`];
  if (card.withoutAmount > 0) {
    notes.push(`${plural(card.withoutAmount, 'solicitud', 'solicitudes')} sin importe capturado`);
  }
  return notes;
}

function buildKpis(cards: Cards): Kpi[] {
  const { pending, quoted, won, response } = cards;
  const responseNotes = [`Meta: menos de ${response.targetHours} h`];
  if (response.averageHours === null) responseNotes.unshift('Sin respuestas enviadas este mes');
  else if (response.withinTarget === false) responseNotes.push('Por encima de la meta');
  if (response.pendingCount > 0) {
    responseNotes.push(`${response.pendingCount} del mes aún sin responder`);
  }
  return [
    {
      key: 'pending',
      label: 'Por atender',
      value: String(pending.total),
      notes: [`${plural(pending.nuevas, 'nueva', 'nuevas')} · ${pending.enRevision} en revisión`],
    },
    {
      key: 'quoted',
      label: 'Cotizadas este mes',
      value: String(quoted.count),
      notes: amountNotes('Valor cotizado', quoted),
    },
    {
      key: 'won',
      label: 'Ganadas este mes',
      value: String(won.count),
      notes: amountNotes('Valor ganado', won),
    },
    {
      key: 'response',
      label: 'Respuesta promedio',
      value: response.averageHours === null ? '—' : `${response.averageHours} h`,
      notes: responseNotes,
    },
  ];
}

/** Las 4 tarjetas de indicadores. */
export function KpiCards({ cards }: { cards: Cards }) {
  return (
    <ul className="kpi-grid" aria-label="Indicadores del mes">
      {buildKpis(cards).map((k) => (
        <li key={k.key} className="kpi">
          <span className="kick">{k.label}</span>
          <p className="big kpi-value">{k.value}</p>
          {k.notes.map((n) => (
            <p key={n} className="muted kpi-note">
              {n}
            </p>
          ))}
        </li>
      ))}
    </ul>
  );
}
