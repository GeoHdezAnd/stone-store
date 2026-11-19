import { PageHeader } from '../components/PageHeader';

/** Pantalla provisional: el contenido real llega en 2.7.2. */
export function PlaceholderPage({ title }: { title: string }) {
  return (
    <>
      <PageHeader title={title} />
      <p className="state">En construcción: se construye en 2.7.2.</p>
    </>
  );
}
