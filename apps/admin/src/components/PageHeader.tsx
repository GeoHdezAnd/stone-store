import type { ReactNode, Ref } from 'react';

export function PageHeader({
  title,
  kicker,
  actions,
  titleRef,
}: {
  title: string;
  kicker?: string;
  /** Controles a la derecha del título (por ejemplo, el botón de alta). */
  actions?: ReactNode;
  /** Para devolver el foco a un elemento estable de la página. */
  titleRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <header className="page-header">
      <div>
        {kicker ? <p className="kick">{kicker}</p> : null}
        <h1 className="page-title" ref={titleRef} tabIndex={-1}>
          {title}
        </h1>
      </div>
      {actions}
    </header>
  );
}
