export function PageHeader({ title, kicker }: { title: string; kicker?: string }) {
  return (
    <header className="page-header">
      <div>
        {kicker ? <p className="kick">{kicker}</p> : null}
        <h1 className="page-title">{title}</h1>
      </div>
    </header>
  );
}

/** Pantalla provisional: el contenido real llega en 2.7.2. */
export function PlaceholderPage({ title }: { title: string }) {
  return (
    <>
      <PageHeader title={title} />
      <p className="state">En construcción: se construye en 2.7.2.</p>
    </>
  );
}
