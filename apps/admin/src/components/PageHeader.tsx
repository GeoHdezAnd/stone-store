import type { ReactNode } from 'react';

export function PageHeader({
  title,
  kicker,
  actions,
}: {
  title: string;
  kicker?: string;
  /** Controles a la derecha del título (por ejemplo, el botón de alta). */
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {kicker ? <p className="kick">{kicker}</p> : null}
        <h1 className="page-title">{title}</h1>
      </div>
      {actions}
    </header>
  );
}
