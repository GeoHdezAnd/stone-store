import { useCallback, useMemo } from 'react';
import { useApi } from '../api/ApiContext';
import { describeError } from '../api/errors';
import { createMetricsApi } from '../api/metricsApi';
import { Notice } from '../components/Notice';
import { PageHeader } from '../components/PageHeader';
import { useAsyncResource } from '../hooks/useAsyncResource';
import { formatDateTime } from '../lib/quoteLabels';
import { KpiCards } from './KpiCards';
import { TopStones, WeeklyBars } from './MetricsCharts';
import { FunnelTable, WaitingTable, ZonesTable } from './MetricsTables';

/** Resumen: indicadores del mes, solicitudes por semana, piedras, embudo, zonas y pendientes. */
export function MetricsScreen() {
  const apiFetch = useApi();
  const api = useMemo(() => createMetricsApi(apiFetch), [apiFetch]);
  const { state, reload, refresh, refreshing, refreshError } = useAsyncResource(
    useCallback(() => api.get(), [api]),
  );

  return (
    <>
      <PageHeader
        title="Resumen"
        kicker="Inicio"
        actions={
          <button
            type="button"
            className="btn btn-secondary"
            disabled={state.status === 'loading' || refreshing}
            onClick={() => void refresh()}
          >
            {refreshing ? 'Actualizando…' : 'Actualizar'}
          </button>
        }
      />

      {state.status === 'loading' ? (
        <p className="state" role="status">
          Cargando el resumen…
        </p>
      ) : state.status === 'error' ? (
        <div className="state">
          <p role="alert">{describeError(state.error)}</p>
          <button type="button" className="btn btn-secondary" onClick={reload}>
            Reintentar
          </button>
        </div>
      ) : (
        <div className="metrics">
          {refreshError !== null ? (
            <Notice tone="error">
              No se pudo actualizar el resumen: {describeError(refreshError)} Se muestran los datos
              anteriores.
            </Notice>
          ) : null}
          {state.data.truncated ? (
            <Notice tone="error">
              Hay más solicitudes de las que este resumen puede leer de una vez: las cifras pueden
              estar incompletas.
            </Notice>
          ) : null}
          {state.data.skipped > 0 ? (
            <Notice>
              {state.data.skipped === 1
                ? '1 solicitud con datos antiguos no se pudo contar.'
                : `${state.data.skipped} solicitudes con datos antiguos no se pudieron contar.`}
            </Notice>
          ) : null}
          {state.data.zonesPartial ? (
            <Notice>Algunas zonas no se pudieron identificar y aparecen como «Sin dato».</Notice>
          ) : null}

          <KpiCards cards={state.data.cards} />

          <div className="metrics-pair">
            <section aria-labelledby="m-weekly">
              <h2 className="sec" id="m-weekly">
                Solicitudes por semana
              </h2>
              <WeeklyBars weekly={state.data.weekly} />
            </section>
            <section aria-labelledby="m-stones">
              <h2 className="sec" id="m-stones">
                Piedras más solicitadas · últimos 30 días
              </h2>
              <TopStones stones={state.data.topStones} />
            </section>
          </div>

          <div className="metrics-pair">
            <section aria-labelledby="m-funnel">
              <h2 className="sec" id="m-funnel">
                Embudo del mes
              </h2>
              <FunnelTable funnel={state.data.funnel} />
            </section>
            <section aria-labelledby="m-zones">
              <h2 className="sec" id="m-zones">
                Solicitudes por zona · últimos 30 días
              </h2>
              <ZonesTable zones={state.data.zones} />
            </section>
          </div>

          <section aria-labelledby="m-waiting">
            <h2 className="sec" id="m-waiting">
              Esperando respuesta
            </h2>
            <p className="muted">
              Nuevas, en revisión y cotizadas que aún no se envían al cliente.
            </p>
            <WaitingTable waiting={state.data.waiting} />
          </section>

          <p className="muted">
            Actualizado el {formatDateTime(state.data.generatedAt)}. Horario de Ciudad de México; el
            mes y la semana se cuentan en ese huso. Importes en pesos, sin IVA.
          </p>
        </div>
      )}
    </>
  );
}
