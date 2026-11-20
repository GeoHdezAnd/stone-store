import type { ReactNode } from 'react';

export interface KeyValue {
  label: string;
  value: ReactNode;
}

/** Lista de datos clave-valor (dl). Presentación pura. */
export function KeyValueList({ items }: { items: readonly KeyValue[] }) {
  return (
    <dl className="publish-card">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
