import { MAIL_TEMPLATE_VARIABLES, renderMailTemplate } from '@canteras/shared';
import type { MailTemplateVariable } from '@canteras/shared';
import type { Draft } from '../lib/draft';

// DATOS DE EJEMPLO: solo sirven para la vista previa; no son de ninguna solicitud real.
const SAMPLE: Record<MailTemplateVariable, string> = {
  nombre: 'María Pérez (ejemplo)',
  folio: 'CN-2026-00042 (ejemplo)',
  piedras: 'Arenisca 210 m² (ejemplo)',
  subtotal: '$100,000 MXN (ejemplo)',
  iva: '$16,000 MXN (16 %) (ejemplo)',
  flete: '$8,000 MXN (ejemplo)',
  total: '$120,000 MXN (ejemplo)',
  vigencia: '15 días (ejemplo)',
};

function preview(template: string): string | null {
  try {
    return renderMailTemplate(template, SAMPLE);
  } catch {
    return null;
  }
}

/** Variables disponibles y vista previa del asunto y la plantilla con datos de ejemplo. */
export function MailTemplateHelp({ draft }: { draft: Draft }) {
  const subject = preview(String(draft.asuntoCotizacion ?? ''));
  const body = preview(String(draft.plantillaCotizacion ?? ''));
  return (
    <div className="mail-help">
      <p className="sec">Variables disponibles</p>
      <p>
        {MAIL_TEMPLATE_VARIABLES.map((name) => (
          <code key={name} className="tag tag-outline">{`{{${name}}}`}</code>
        ))}
      </p>
      <p className="sec">Vista previa (con datos de ejemplo)</p>
      {subject === null || body === null ? (
        <p className="muted">
          La vista previa no está disponible mientras haya variables no válidas.
        </p>
      ) : (
        <>
          <p>
            <strong>Asunto:</strong> {subject}
          </p>
          <pre className="mail-preview">{body}</pre>
        </>
      )}
    </div>
  );
}
