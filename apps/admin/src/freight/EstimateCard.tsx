import type { FreightEstimate } from '@canteras/shared';
import { formatMxn, formatNumber } from '../lib/freightLabels';

/** Resultado de una estimación de flete. Presentación pura. */
export function EstimateCard({ estimate }: { estimate: FreightEstimate }) {
  return (
    <div className="publish-card-wrap" role="status">
      {estimate.ejemplo ? <p className="tag tag-outline">Datos de ejemplo</p> : null}
      <dl className="publish-card">
        <div>
          <dt>Estimado</dt>
          <dd className="big">
            {formatMxn(estimate.estimadoMin)} – {formatMxn(estimate.estimadoMax)}
          </dd>
        </div>
        <div>
          <dt>Peso total</dt>
          <dd>{formatNumber(estimate.pesoTotalKg)} kg</dd>
        </div>
        <div>
          <dt>Distancia</dt>
          <dd>{formatNumber(estimate.distanciaKm)} km</dd>
        </div>
        <div>
          <dt>Camión</dt>
          <dd>{estimate.camion}</dd>
        </div>
        <div>
          <dt>Viajes</dt>
          <dd>{estimate.viajes}</dd>
        </div>
        <div>
          <dt>Versión de tarifa</dt>
          <dd>{estimate.versionTarifa}</dd>
        </div>
      </dl>
      <p className="muted">{estimate.aviso}</p>
    </div>
  );
}
