import type { ReactNode } from 'react';

/** Etiqueta con tono (el significado siempre va en el texto, no solo en el color). */
export function Tag({
  tone = 'outline',
  children,
}: {
  tone?: 'ink' | 'outline' | 'accent';
  children: ReactNode;
}) {
  return <span className={`tag tag-${tone}`}>{children}</span>;
}
