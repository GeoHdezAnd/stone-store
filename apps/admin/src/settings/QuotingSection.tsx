import { useId, useState } from 'react';
import type { IvaPct, QuotingSettings } from '@canteras/shared';
import { describeError } from '../api/errors';
import { SelectField } from '../components/SelectField';
import { useToastedAction } from '../hooks/useToastedAction';
import { IVA_CHOICES, ivaPctToText, parseIvaPct } from '../lib/quoteLabels';

interface QuotingSectionProps {
  initial: QuotingSettings;
  /** Solo el dueño edita; el staff la lee. */
  canEdit: boolean;
  onSave: (values: QuotingSettings) => Promise<void>;
}

/** IVA por defecto del formulario de cotización (preselecciona; el dueño puede cambiarlo en cada una). */
export function QuotingSection({ initial, canEdit, onSave }: QuotingSectionProps) {
  const headingId = useId();
  const { pending, run } = useToastedAction();
  const [value, setValue] = useState(ivaPctToText(initial.ivaPctDefault));
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const ivaPctDefault: IvaPct = parseIvaPct(value);
    try {
      await run(() => onSave({ ivaPctDefault }), {
        loading: 'Guardando…',
        success: 'Configuración de cotización guardada.',
      });
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <section aria-labelledby={headingId} className="settings-section">
      <h2 id={headingId} className="sec">
        Cotización
      </h2>
      <p className="muted">
        IVA que se preselecciona al cotizar por primera vez. El IVA se calcula solo sobre la piedra;
        el flete no lleva IVA. En cada cotización el dueño puede elegir otra tasa.
      </p>
      {!canEdit ? <p className="muted">Solo el dueño puede editar esta sección.</p> : null}
      <form className="form" onSubmit={(e) => void submit(e)} noValidate>
        {error ? (
          <div className="notice notice-error" role="alert">
            {error}
          </div>
        ) : null}
        <SelectField
          label="IVA por defecto"
          value={value}
          options={IVA_CHOICES}
          disabled={!canEdit || pending}
          onChange={setValue}
        />
        {canEdit ? (
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={pending}>
              Guardar
            </button>
          </div>
        ) : null}
      </form>
    </section>
  );
}
