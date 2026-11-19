import type { ReactNode } from 'react';

export interface Column<Row> {
  key: string;
  header: string;
  render: (row: Row) => ReactNode;
  numeric?: boolean;
}

interface DataTableProps<Row> {
  /** Descripción para lectores de pantalla (la tabla no muestra el título). */
  caption: string;
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  getRowKey: (row: Row) => string;
  /** Si se pasa, agrega una última columna con los controles de cada fila. */
  renderActions?: (row: Row) => ReactNode;
  actionsHeader?: string;
}

/** Tabla de presentación: no sabe de la entidad ni de la API. */
export function DataTable<Row>({
  caption,
  columns,
  rows,
  getRowKey,
  renderActions,
  actionsHeader = 'Acciones',
}: DataTableProps<Row>) {
  return (
    <div className="wrap-x">
      <table className="table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} scope="col" className={col.numeric ? 'num' : undefined}>
                {col.header}
              </th>
            ))}
            {renderActions ? <th scope="col">{actionsHeader}</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={getRowKey(row)}>
              {columns.map((col) => (
                <td key={col.key} className={col.numeric ? 'num' : undefined}>
                  {col.render(row)}
                </td>
              ))}
              {renderActions ? <td>{renderActions(row)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
