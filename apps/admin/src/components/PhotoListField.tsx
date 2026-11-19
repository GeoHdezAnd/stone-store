import { useId, useRef, useState } from 'react';

interface PhotoListFieldProps {
  /** Claves de las fotos, en orden. */
  value: readonly string[];
  onChange: (value: string[]) => void;
  /** Sube el archivo y devuelve la clave nueva (lanza si falla). */
  onUpload: (file: File) => Promise<string>;
  disabled?: boolean;
  /** Si hay texto, la subida queda deshabilitada y se muestra como nota. */
  uploadBlockedReason?: string | undefined;
  uploading?: boolean;
  accept?: string;
  /** Permite escoger varias fotos a la vez en el selector de archivos. */
  multiple?: boolean;
}

/**
 * Lista de fotos por clave: subir, quitar y reordenar con botones (sin arrastrar).
 * Presentación pura: no sabe de S3 ni de la entidad dueña.
 */
export function PhotoListField({
  value,
  onChange,
  onUpload,
  disabled = false,
  uploadBlockedReason,
  uploading = false,
  accept = 'image/jpeg,image/png,image/webp,image/avif',
  multiple = true,
}: PhotoListFieldProps) {
  const fileId = useId();
  const noteId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  // Ocupado durante todo el lote: evita quitar o reordenar mientras se sube (el lote agrega al
  // final de la lista que había al elegir los archivos).
  const [batchBusy, setBatchBusy] = useState(false);
  const busy = uploading || batchBusy;

  function move(index: number, delta: -1 | 1) {
    const next = [...value];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  }

  /** Sube los archivos de uno en uno y agrega al final las claves que sí se subieron. */
  async function handleFiles(files: FileList | null) {
    const selected = files ? Array.from(files) : [];
    if (selected.length === 0) return;
    const uploaded: string[] = [];
    setBatchBusy(true);
    try {
      for (const file of selected) {
        try {
          uploaded.push(await onUpload(file));
        } catch {
          /* quien sube ya informó el error de este archivo; se sigue con los demás */
        }
      }
    } finally {
      setBatchBusy(false);
      if (uploaded.length > 0) onChange([...value, ...uploaded]);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  const blocked = uploadBlockedReason !== undefined;
  return (
    <div>
      {value.length === 0 ? (
        <p className="muted">Sin fotos.</p>
      ) : (
        <ol className="photo-list">
          {value.map((key, i) => (
            <li key={key} className="photo-item">
              <span className="photo-key">{key}</span>
              <button
                type="button"
                className="btn btn-ghost"
                aria-label={`Subir la foto ${i + 1} de ${value.length}: ${key}`}
                disabled={disabled || busy || i === 0}
                onClick={() => move(i, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                aria-label={`Bajar la foto ${i + 1} de ${value.length}: ${key}`}
                disabled={disabled || busy || i === value.length - 1}
                onClick={() => move(i, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                aria-label={`Quitar la foto ${i + 1} de ${value.length}: ${key}`}
                disabled={disabled || busy}
                onClick={() => onChange(value.filter((_, j) => j !== i))}
              >
                Quitar
              </button>
            </li>
          ))}
        </ol>
      )}
      <label className="sr-only" htmlFor={fileId}>
        {multiple ? 'Agregar fotos' : 'Agregar foto'}
      </label>
      <input
        ref={inputRef}
        id={fileId}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled || blocked || busy}
        aria-describedby={blocked ? noteId : undefined}
        onChange={(e) => void handleFiles(e.target.files)}
      />
      {blocked ? (
        <p className="hint" id={noteId}>
          {uploadBlockedReason}
        </p>
      ) : (
        <p className="hint">
          JPEG, PNG, WebP o AVIF, máximo 5 MiB cada una. Se guarda al guardar el registro.
        </p>
      )}
    </div>
  );
}
