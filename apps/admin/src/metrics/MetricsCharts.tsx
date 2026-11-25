import type { MetricsResponse } from '@canteras/shared';

/** Alto de la barra como porcentaje del máximo (0 si no hay datos; mínimo visible si hay 1+). */
function percent(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return Math.max(4, Math.round((value / max) * 100));
}

/** Barras de las últimas 8 semanas, en CSS puro. La última (semana actual) va en el acento. */
export function WeeklyBars({ weekly }: { weekly: MetricsResponse['weekly'] }) {
  const max = Math.max(0, ...weekly.map((w) => w.count));
  const description = weekly.map((w) => `semana del ${w.label}: ${w.count}`).join('; ');
  return (
    <div>
      <div
        className="bars"
        role="img"
        aria-label={`Solicitudes por semana, de la más antigua a la actual (${description})`}
      >
        {weekly.map((w, i) => (
          <div key={w.start} className="bar-col">
            <span className="bar-value">{w.count}</span>
            <div
              className={i === weekly.length - 1 ? 'bar bar-current' : 'bar'}
              style={{ height: `${percent(w.count, max)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="bar-labels" aria-hidden="true">
        {weekly.map((w) => (
          <span key={w.start} className="muted">
            {w.label}
          </span>
        ))}
      </div>
      <p className="muted bar-note">
        Semanas de lunes a domingo; la última es la semana en curso (resaltada).
      </p>
    </div>
  );
}

/** Barras horizontales de las piedras más solicitadas. */
export function TopStones({ stones }: { stones: MetricsResponse['topStones'] }) {
  if (stones.length === 0) {
    return <p className="muted">Aún no hay solicitudes en los últimos 30 días.</p>;
  }
  const max = Math.max(...stones.map((s) => s.count));
  return (
    <ol className="hbars">
      {stones.map((s) => (
        <li key={s.stoneId}>
          <div className="hbar-head">
            <span>{s.nombre}</span>
            <span className="num">{s.count}</span>
          </div>
          <div className="hbar-track" aria-hidden="true">
            <div className="hbar-fill" style={{ width: `${percent(s.count, max)}%` }} />
          </div>
        </li>
      ))}
    </ol>
  );
}
