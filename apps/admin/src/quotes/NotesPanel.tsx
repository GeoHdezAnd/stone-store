import type { Quote } from '@canteras/shared';
import { MAX_NOTE_LENGTH } from '@canteras/shared';
import { useId, useState } from 'react';
import { formatDateTime, shortUser } from '../lib/publishLabels';

/** Notas internas: lista y alta. El borrador vive aquí y no se pierde si la escritura falla. */
export function NotesPanel({
  notes,
  onAdd,
  disabled = false,
}: {
  notes: Quote['notes'];
  /** Debe lanzar si falla (el texto escrito se conserva); si sale bien se limpia el campo. */
  onAdd: (texto: string) => Promise<void>;
  disabled?: boolean;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    const texto = text.trim();
    if (!texto || busy) return;
    setBusy(true);
    try {
      await onAdd(texto);
      setText('');
    } catch {
      /* el padre ya informó el error; se conserva lo escrito */
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="muted">Interna: nunca se envía al cliente.</p>
      {notes.length === 0 ? <p className="muted">Sin notas.</p> : null}
      <ul className="photo-list">
        {[...notes].reverse().map((n) => (
          <li key={`${n.at}-${n.by}`} className="photo-item">
            <span className="photo-key">{n.texto}</span>
            <span className="muted">
              {shortUser(n.by)} · {formatDateTime(n.at)}
            </span>
          </li>
        ))}
      </ul>
      <div className="field">
        <label htmlFor={id}>Nueva nota interna</label>
        <textarea
          id={id}
          className="input"
          rows={3}
          maxLength={MAX_NOTE_LENGTH}
          value={text}
          disabled={disabled || busy}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      <button
        type="button"
        className="btn btn-secondary"
        disabled={disabled || busy || text.trim() === ''}
        onClick={() => void submit()}
      >
        Agregar nota
      </button>
    </div>
  );
}
