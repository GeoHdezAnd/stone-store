import { useEffect, useMemo, useState } from 'react';
import { describeError } from '../api/errors';
import { CheckboxGroup } from '../components/CheckboxGroup';
import type { FieldRenderProps } from '../components/fieldTypes';
import { useCatalogApi } from '../hooks/useCatalogApi';
import { usePagedList } from '../hooks/usePagedList';

interface Row {
  id: string;
  activa?: boolean;
}

/**
 * Campo `custom` para elegir registros de otro recurso del catálogo por id, mostrando su nombre.
 * Carga todas las páginas de `/admin/<segment>`. Si la carga falla, deja editar los ids a mano.
 */
export function ReferenceMultiSelect({
  segment,
  labelOf,
  props,
}: {
  segment: string;
  labelOf: (row: Row & Record<string, unknown>) => string;
  props: FieldRenderProps;
}) {
  const api = useCatalogApi<Row & Record<string, unknown>>(segment);
  const list = usePagedList(api.list);
  const selected = Array.isArray(props.value) ? props.value : [];

  // Trae todas las páginas (los selects necesitan todas las opciones).
  const { status, hasMore, loadingMore, loadMore, error } = list;
  useEffect(() => {
    if (status === 'ready' && hasMore && !loadingMore && !error) void loadMore();
  }, [status, hasMore, loadingMore, loadMore, error]);

  const options = useMemo(() => {
    const known = list.items.map((row) => ({
      value: row.id,
      label: row.activa === false ? `${labelOf(row)} (inactivo)` : labelOf(row),
    }));
    // Ids guardados que ya no existen se conservan visibles para poder quitarlos.
    const missing = selected
      .filter((id) => !known.some((o) => o.value === id))
      .map((id) => ({ value: id, label: `${id} (no encontrado)` }));
    return [...known, ...missing];
  }, [list.items, selected, labelOf]);

  if (list.status === 'error' || list.error) {
    return (
      <IdsTextarea
        id={props.inputId}
        labelledBy={`${props.inputId}-label`}
        value={selected}
        onChange={props.onChange}
        disabled={props.disabled}
        warning={`No pudimos cargar la lista. ${describeError(list.error)} Edita los ids a mano.`}
      />
    );
  }
  if (list.status === 'loading' || list.hasMore) {
    return (
      <p className="muted" role="status">
        Cargando opciones…
      </p>
    );
  }
  if (options.length === 0) return <p className="muted">No hay registros para elegir.</p>;
  return (
    <CheckboxGroup
      options={options}
      value={selected}
      onChange={props.onChange}
      disabled={props.disabled}
    />
  );
}

/** Respaldo: ids uno por línea. Conserva el texto mientras se escribe. */
function IdsTextarea({
  id,
  labelledBy,
  value,
  onChange,
  disabled,
  warning,
}: {
  id: string;
  labelledBy: string;
  value: string[];
  onChange: (value: string[]) => void;
  disabled: boolean;
  warning: string;
}) {
  const [text, setText] = useState(() => value.join('\n'));
  return (
    <>
      <p className="notice notice-error" role="alert">
        {warning}
      </p>
      <textarea
        id={id}
        aria-labelledby={labelledBy}
        className="input"
        rows={4}
        disabled={disabled}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(
            e.target.value
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter(Boolean),
          );
        }}
      />
    </>
  );
}
