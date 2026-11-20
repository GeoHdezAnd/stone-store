import { isUlid } from '@canteras/shared';
import { useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, describeError } from '../api/errors';
import { PageHeader } from '../components/PageHeader';
import { useAsyncResource } from '../hooks/useAsyncResource';
import { useQuotesApi } from '../hooks/useQuotesApi';
import { QuoteDetail } from './QuoteDetail';

function NotFound() {
  return (
    <>
      <PageHeader title="Solicitud" />
      <div className="state">
        <p role="alert">No encontramos esta solicitud. Puede que ya no exista.</p>
        <Link className="btn btn-secondary" to="/quotes">
          Volver a solicitudes
        </Link>
      </div>
    </>
  );
}

/** Carga la solicitud por el id de la URL; un id inválido o inexistente es «no encontrado». */
export function QuoteDetailScreen() {
  const { quoteId = '' } = useParams();
  if (!isUlid(quoteId)) return <NotFound />;
  return <Loaded key={quoteId} quoteId={quoteId} />;
}

function Loaded({ quoteId }: { quoteId: string }) {
  const api = useQuotesApi();
  const { state, reload } = useAsyncResource(useCallback(() => api.get(quoteId), [api, quoteId]));

  if (state.status === 'loading') {
    return (
      <p className="state" role="status">
        Cargando…
      </p>
    );
  }
  if (state.status === 'error') {
    if (state.error instanceof ApiError && state.error.code === 'not_found') return <NotFound />;
    return (
      <div className="state">
        <p role="alert">{describeError(state.error)}</p>
        <button type="button" className="btn btn-secondary" onClick={reload}>
          Reintentar
        </button>
      </div>
    );
  }
  return <QuoteDetail initial={state.data} />;
}
