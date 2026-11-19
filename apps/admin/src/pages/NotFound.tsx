import { Link } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';

export function NotFoundPage() {
  return (
    <>
      <PageHeader title="Página no encontrada" />
      <p>
        La dirección que buscas no existe en este panel. <Link to="/">Volver al inicio</Link>
      </p>
    </>
  );
}
