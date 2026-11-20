import type { FreightEstimate, Stone } from '@canteras/shared';
import { useMemo, useState } from 'react';
import type { FreightApi, FreightVersionSummary } from '../api/freightApi';
import { describeError } from '../api/errors';
import { Notice } from '../components/Notice';
import { SelectField } from '../components/SelectField';
import { useAllItems } from '../hooks/useAllItems';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { unitLabel } from '../lib/freightLabels';
import { EstimateCard } from './EstimateCard';
import { blankRow, buildSimulateRequest, withStone, withUnit } from './simulatorRows';
import type { SimRow } from './simulatorRows';

/** Simulador de flete (owner y staff): no crea solicitudes, solo calcula. */
export function FreightSimulator({
  api,
  versions,
}: {
  api: FreightApi;
  versions: readonly FreightVersionSummary[];
}) {
  const stonesList = useAllItems<Stone>('stones');
  const stones = useMemo(() => stonesList.items.filter((s) => s.activa), [stonesList.items]);
  const { pending, run } = useAsyncAction();

  const [codigoPostal, setCodigoPostal] = useState('');
  const [distanciaKm, setDistanciaKm] = useState('');
  const [rows, setRows] = useState<SimRow[]>([blankRow()]);
  const [version, setVersion] = useState('');
  const [skipZoneCheck, setSkipZoneCheck] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  // El resultado y el error de la API se asocian a las entradas con que se calcularon: si cambian,
  // dejan de mostrarse (no se enseña un estimado desactualizado).
  const [apiOutcome, setApiOutcome] = useState<{ key: string; error: string } | null>(null);
  const [outcome, setOutcome] = useState<{ key: string; estimate: FreightEstimate } | null>(null);
  const inputsKey = JSON.stringify([codigoPostal, distanciaKm, rows, version, skipZoneCheck]);
  const result = outcome?.key === inputsKey ? outcome.estimate : null;
  const apiError = apiOutcome?.key === inputsKey ? apiOutcome.error : null;

  const stoneOptions = stones.map((s) => ({ value: s.id, label: s.nombre }));
  const setRow = (i: number, next: SimRow) =>
    setRows((prev) => prev.map((r, j) => (j === i ? next : r)));

  async function calculate() {
    setErrors([]);
    setApiOutcome(null);
    setOutcome(null);
    const key = inputsKey;
    const built = buildSimulateRequest({ codigoPostal, distanciaKm, rows, version, skipZoneCheck });
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    try {
      const estimate = await run(() => api.simulate(built.request));
      setOutcome({ key, estimate });
    } catch (err) {
      setApiOutcome({ key, error: describeError(err) });
    }
  }

  return (
    <form
      className="form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!pending) void calculate();
      }}
    >
      {stonesList.status === 'error' ? (
        <Notice tone="error">
          No pudimos cargar las piedras. {describeError(stonesList.error)}
        </Notice>
      ) : null}

      <div className="form-grid">
        <div className="field">
          <label htmlFor="sim-cp">Código postal</label>
          <input
            id="sim-cp"
            className="input"
            inputMode="numeric"
            value={codigoPostal}
            onChange={(e) => setCodigoPostal(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="sim-km">Distancia (km)</label>
          <input
            id="sim-km"
            className="input"
            inputMode="decimal"
            value={distanciaKm}
            aria-describedby="sim-km-hint"
            onChange={(e) => setDistanciaKm(e.target.value)}
          />
          <span className="hint" id="sim-km-hint">
            Hasta la fase 5 la distancia se captura a mano.
          </span>
        </div>
        <SelectField
          label="Versión de tarifa"
          value={version}
          onChange={setVersion}
          placeholder="La activa"
          options={versions.map((v) => ({
            value: v.version,
            label: `${v.version}${v.activa ? ' (activa)' : ''}`,
          }))}
        />
        <div className="field">
          <label className="check-option" htmlFor="sim-skip">
            <input
              id="sim-skip"
              type="checkbox"
              checked={skipZoneCheck}
              onChange={(e) => setSkipZoneCheck(e.target.checked)}
            />
            Omitir validación de zona
          </label>
        </div>
      </div>

      <div className="rows-field">
        {rows.map((row, i) => {
          const stone = stones.find((s) => s.id === row.stoneId);
          return (
            <fieldset key={i} className="rows-item">
              <legend>Piedra {i + 1}</legend>
              <div className="rows-grid">
                <SelectField
                  label="Piedra"
                  value={row.stoneId}
                  placeholder="Elige una piedra"
                  options={stoneOptions}
                  onChange={(id) => setRow(i, withStone(row, id, stones))}
                />
                <SelectField
                  label="Unidad"
                  value={row.unidad}
                  disabled={!stone}
                  options={(stone?.vendidaPor ?? []).map((u) => ({
                    value: u,
                    label: unitLabel(u),
                  }))}
                  onChange={(u) => setRow(i, withUnit(row, u, stones))}
                />
                <div className="field">
                  <label htmlFor={`sim-qty-${i}`}>Cantidad</label>
                  <input
                    id={`sim-qty-${i}`}
                    className="input"
                    inputMode="decimal"
                    value={row.cantidad}
                    onChange={(e) => setRow(i, { ...row, cantidad: e.target.value })}
                  />
                </div>
                {row.unidad === 'm2' ? (
                  <SelectField
                    label="Espesor (cm)"
                    value={row.espesor}
                    placeholder="Elige"
                    options={(stone?.espesoresCm ?? []).map((e) => ({
                      value: String(e),
                      label: `${e} cm`,
                    }))}
                    onChange={(e) => setRow(i, { ...row, espesor: e })}
                  />
                ) : null}
              </div>
              {rows.length > 1 ? (
                <button
                  type="button"
                  className="link-btn"
                  aria-label={`Quitar la piedra ${i + 1}`}
                  onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                >
                  Quitar
                </button>
              ) : null}
            </fieldset>
          );
        })}
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setRows((prev) => [...prev, blankRow()])}
        >
          Agregar piedra
        </button>
      </div>

      {errors.length > 0 ? <Notice tone="error">{errors.join(' ')}</Notice> : null}
      {apiError ? <Notice tone="error">{apiError}</Notice> : null}

      <div className="form-actions">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={pending || stonesList.status !== 'ready'}
        >
          {pending ? 'Calculando…' : 'Calcular'}
        </button>
      </div>

      {result ? <EstimateCard estimate={result} /> : null}
    </form>
  );
}
