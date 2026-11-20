import { SEND_LOCK_TTL_MS, maskEmail } from '@canteras/shared';
import type { LostReason, Quote, QuoteStatus } from '@canteras/shared';
import { LOST_REASONS } from '@canteras/shared';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, describeError } from '../api/errors';
import type { QuotePatch } from '../api/quotesApi';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Notice } from '../components/Notice';
import { PageHeader } from '../components/PageHeader';
import { SelectField } from '../components/SelectField';
import { Tag } from '../components/Tag';
import { useBefore } from '../hooks/useBefore';
import { usePermissions } from '../hooks/usePermissions';
import { useQuotesApi } from '../hooks/useQuotesApi';
import { useToastedAction } from '../hooks/useToastedAction';
import { LOST_REASON_LABELS, STATUS_TONES, formatMxn, statusLabel } from '../lib/quoteLabels';
import { whatsappLink } from '../lib/whatsapp';
import { FinalQuoteForm } from './FinalQuoteForm';
import { NotesPanel } from './NotesPanel';
import {
  ClientBlock,
  FinalQuoteSummary,
  FreightBlock,
  HistoryBlock,
  StonesBlock,
} from './QuoteSections';
import { useFinalQuoteDraft } from './useFinalQuoteDraft';

type Problem = { kind: 'conflict'; text: string } | { kind: 'sent'; text: string } | null;
type Dialog = 'send' | 'lost' | 'cancel' | null;

const PREPARATION: readonly QuoteStatus[] = ['en_revision', 'cotizada'];
/** Estados que se pueden fijar por PATCH (`enviada` solo con «Enviar cotización»). */
type NextStatus = 'en_revision' | 'cotizada' | 'ganada' | 'perdida' | 'cancelada';
const NEXT_STEPS: readonly NextStatus[] = [
  'en_revision',
  'cotizada',
  'ganada',
  'perdida',
  'cancelada',
];

function transitionLabel(from: QuoteStatus, to: QuoteStatus): string {
  if (to === 'en_revision') return from === 'cotizada' ? 'Regresar a revisión' : 'Pasar a revisión';
  if (to === 'cotizada') return 'Marcar como cotizada';
  if (to === 'ganada') return 'Marcar ganada';
  if (to === 'perdida') return 'Marcar perdida';
  return 'Cancelar solicitud';
}

/** Contenedor del detalle: estado de la solicitud, escrituras con `rev` y manejo de conflictos. */
export function QuoteDetail({ initial }: { initial: Quote }) {
  const api = useQuotesApi();
  const { canSendQuote, canTransitionTo } = usePermissions();
  const { pending: requestPending, run } = useToastedAction();
  const [quote, setQuote] = useState(initial);
  const [problem, setProblem] = useState<Problem>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [lostReason, setLostReason] = useState('');
  const [formErrors, setFormErrors] = useState<string[]>([]);
  // Tras `conflict_after_send` no se vuelve a enviar hasta que una recarga confirme el estado.
  const [sentUnconfirmed, setSentUnconfirmed] = useState(false);
  // Devuelve el foco a un elemento estable cuando un diálogo cierra y su botón desaparece.
  const titleRef = useRef<HTMLHeadingElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (dialog === null && refocus.current) {
      refocus.current = false;
      titleRef.current?.focus();
    }
  }, [dialog]);
  const closeDialog = () => {
    refocus.current = true;
    setDialog(null);
  };
  // El borrador vive aquí: un 409 o una recarga no borran lo que se escribió.
  const finalDraft = useFinalQuoteDraft(quote);

  // Candado de envío vigente (lo pone el servidor): no se escribe hasta que termine o venza.
  const lockActive = useBefore(
    quote.sendLock === undefined ? null : Date.parse(quote.sendLock.at) + SEND_LOCK_TTL_MS,
  );
  // Anti doble clic: todo queda deshabilitado mientras hay una petición o un envío en curso.
  const pending = requestPending || lockActive;
  const editable = PREPARATION.includes(quote.status);
  const total = quote.finalQuote?.total;

  /** Vuelve a leer la solicitud (con su `rev` real). Devuelve si salió bien. */
  async function refresh(): Promise<boolean> {
    try {
      setQuote(await api.get(quote.quoteId));
      setProblem(null);
      setSentUnconfirmed(false);
      return true;
    } catch (err) {
      setProblem({ kind: 'conflict', text: describeError(err) });
      return false;
    }
  }

  /** Toda escritura manda `rev`; ante un conflicto se ofrece recargar sin perder el borrador. */
  async function mutate(
    action: () => Promise<Quote>,
    messages: { loading: string; success: string },
  ): Promise<boolean> {
    setProblem(null);
    try {
      setQuote(await run(action, messages));
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'conflict_after_send') {
        // El correo ya salió: Enviar queda bloqueado hasta que una recarga confirme el estado.
        setSentUnconfirmed(true);
        const reloaded = await refresh();
        setProblem(
          reloaded
            ? { kind: 'sent', text: describeError(err) }
            : { kind: 'conflict', text: `${describeError(err)} No pudimos recargar la solicitud.` },
        );
      } else if (err instanceof ApiError && err.kind === 'conflict') {
        setProblem({ kind: 'conflict', text: describeError(err) });
      }
      return false;
    }
  }

  const patch = (body: QuotePatch, messages: { loading: string; success: string }) =>
    mutate(() => api.patch(quote.quoteId, quote.rev, body), messages);

  function savePrices() {
    const valid = finalDraft.validate();
    setFormErrors(valid.ok ? [] : valid.errors);
    if (!valid.ok) return;
    void patch(
      { finalQuote: valid.value },
      { loading: 'Guardando precios…', success: 'Precios guardados.' },
    );
  }

  function transition(to: NextStatus) {
    if (to === 'perdida') return setDialog('lost');
    if (to === 'cancelada') return setDialog('cancel');
    if (to === 'cotizada') {
      // Cotizar exige precios y flete en la misma petición.
      const valid = finalDraft.validate();
      setFormErrors(valid.ok ? [] : valid.errors);
      if (!valid.ok) return;
      return void patch(
        { status: 'cotizada', finalQuote: valid.value },
        { loading: 'Cotizando…', success: 'Solicitud cotizada.' },
      );
    }
    void patch(
      { status: to },
      { loading: 'Actualizando…', success: `Solicitud en estado «${statusLabel(to)}».` },
    );
  }

  const unsavedChanges = editable && finalDraft.dirty;
  const sendBlocked = sentUnconfirmed || unsavedChanges;
  const nextSteps = NEXT_STEPS.filter((to) => canTransitionTo(quote.status, to));
  const message = [
    `Hola ${quote.customer.nombre}, te escribimos de Canteras Naturales sobre tu solicitud ${quote.folio}`,
    `(${quote.items.map((i) => i.nombre).join(', ')}).`,
    total === undefined ? '' : `Total: ${formatMxn(total)} (sin IVA).`,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <PageHeader
        titleRef={titleRef}
        title={quote.folio}
        kicker="Solicitud"
        actions={<Tag tone={STATUS_TONES[quote.status]}>{statusLabel(quote.status)}</Tag>}
      />
      <p>
        <Link className="link-btn" to="/quotes">
          Volver a solicitudes
        </Link>
      </p>

      {lockActive ? (
        <Notice>
          Envío en curso: se está enviando esta cotización. Espera unos segundos y{' '}
          <button type="button" className="link-btn" onClick={() => void refresh()}>
            Recargar
          </button>
        </Notice>
      ) : null}
      {problem ? (
        <Notice tone={problem.kind === 'sent' ? 'info' : 'error'}>
          {problem.text}{' '}
          {problem.kind === 'conflict' ? (
            <button type="button" className="link-btn" onClick={() => void refresh()}>
              Recargar
            </button>
          ) : null}
        </Notice>
      ) : null}

      <section className="publish-section" aria-labelledby="q-client">
        <h2 className="sec" id="q-client">
          Cliente y obra
        </h2>
        <ClientBlock quote={quote} />
      </section>

      <section className="publish-section" aria-labelledby="q-stones">
        <h2 className="sec" id="q-stones">
          Piedras solicitadas
        </h2>
        <StonesBlock items={quote.items} />
      </section>

      <section className="publish-section" aria-labelledby="q-freight">
        <h2 className="sec" id="q-freight">
          Estimado automático de flete
        </h2>
        <FreightBlock quote={quote} />
      </section>

      <section className="publish-section" aria-labelledby="q-final">
        <h2 className="sec" id="q-final">
          Cotización final
        </h2>
        {editable ? (
          <>
            <FinalQuoteForm
              quote={quote}
              draft={finalDraft.draft}
              onDraftChange={finalDraft.setDraft}
              preview={finalDraft.preview}
              onAcceptEstimate={finalDraft.acceptEstimate}
              canAcceptEstimate={quote.freight !== undefined}
              disabled={pending}
              errors={formErrors}
            />
            <div className="quote-actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={pending}
                onClick={savePrices}
              >
                Guardar precios
              </button>
            </div>
            {quote.finalQuote ? <FinalQuoteSummary quote={quote} /> : null}
          </>
        ) : (
          <FinalQuoteSummary quote={quote} />
        )}
      </section>

      <section className="publish-section" aria-labelledby="q-actions">
        <h2 className="sec" id="q-actions">
          Acciones
        </h2>
        <div className="quote-actions">
          {nextSteps.map((to) => (
            <button
              key={to}
              type="button"
              className={to === 'cotizada' ? 'btn btn-primary' : 'btn btn-secondary'}
              disabled={pending}
              onClick={() => transition(to)}
            >
              {transitionLabel(quote.status, to)}
            </button>
          ))}
          {canSendQuote && quote.status === 'cotizada' ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={pending || sendBlocked}
              onClick={() => setDialog('send')}
            >
              Enviar cotización
            </button>
          ) : null}
          {canSendQuote && quote.status === 'cotizada' && sendBlocked ? (
            <p className="muted" role="status">
              {sentUnconfirmed
                ? 'Recarga la solicitud para confirmar el envío antes de volver a enviar.'
                : 'Guarda los cambios antes de enviar.'}
            </p>
          ) : null}
          <a
            className="btn btn-secondary"
            href={whatsappLink(quote.customer.telefono, message)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Responder por WhatsApp
          </a>
        </div>
        {nextSteps.length === 0 && !(canSendQuote && quote.status === 'cotizada') ? (
          <p className="muted">No hay cambios de estado disponibles para tu rol en este estado.</p>
        ) : null}
      </section>

      <section className="publish-section" aria-labelledby="q-timeline">
        <h2 className="sec" id="q-timeline">
          Línea de tiempo
        </h2>
        <HistoryBlock history={quote.history} />
      </section>

      <section className="publish-section" aria-labelledby="q-notes">
        <h2 className="sec" id="q-notes">
          Notas internas
        </h2>
        <NotesPanel
          notes={quote.notes}
          disabled={pending}
          onAdd={async (texto) => {
            const ok = await mutate(() => api.addNote(quote.quoteId, quote.rev, texto), {
              loading: 'Guardando nota…',
              success: 'Nota agregada.',
            });
            if (!ok) throw new Error('nota no guardada');
          }}
        />
      </section>

      <ConfirmDialog
        open={dialog === 'send'}
        title="Enviar cotización"
        confirmLabel="Enviar"
        busy={pending}
        onConfirm={() =>
          void mutate(() => api.send(quote.quoteId, quote.rev), {
            loading: 'Enviando…',
            success: 'Cotización enviada.',
          }).then(closeDialog)
        }
        onCancel={() => setDialog(null)}
      >
        Se enviará la cotización a {maskEmail(quote.customer.correo)} por un total de{' '}
        {total === undefined ? '—' : formatMxn(total)} (sin IVA). El correo no se puede deshacer.
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === 'lost'}
        title="Marcar como perdida"
        confirmLabel="Marcar perdida"
        busy={pending}
        confirmDisabled={lostReason === ''}
        onConfirm={() =>
          void patch(
            { status: 'perdida', lostReason: lostReason as LostReason },
            { loading: 'Actualizando…', success: 'Solicitud marcada como perdida.' },
          ).then(closeDialog)
        }
        onCancel={() => setDialog(null)}
      >
        <SelectField
          label="Motivo (obligatorio)"
          value={lostReason}
          placeholder="Elige un motivo"
          options={LOST_REASONS.map((r) => ({ value: r, label: LOST_REASON_LABELS[r] }))}
          onChange={setLostReason}
        />
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === 'cancel'}
        title="Cancelar la solicitud"
        confirmLabel="Cancelar solicitud"
        cancelLabel="Volver"
        busy={pending}
        onConfirm={() =>
          void patch(
            { status: 'cancelada' },
            { loading: 'Cancelando…', success: 'Solicitud cancelada.' },
          ).then(closeDialog)
        }
        onCancel={() => setDialog(null)}
      >
        La solicitud pasará a «Cancelada» y ya no se podrá cambiar.
      </ConfirmDialog>
    </>
  );
}
