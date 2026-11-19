import type { Draft, FieldDef } from '../components/fieldTypes';

export type { Draft };

function parseNumber(text: string): number | undefined {
  const t = text.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isNaN(n) ? undefined : n;
}

const asLines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

const asTokens = (text: string) => text.split(/[,\s]+/).filter(Boolean);

/** Valores guardados → borrador de formulario (todo texto, salvo casillas y listas de opciones). */
export function toDraft<T>(
  values: Record<string, unknown> | null,
  fields: readonly FieldDef<T>[],
  options: { blankNumbers?: boolean } = {},
): Draft {
  const draft: Draft = {};
  for (const f of fields) {
    const v = f.group ? groupValue(values, f.group) : values?.[f.name];
    switch (f.kind) {
      case 'checkbox':
        draft[f.name] = v === true;
        break;
      case 'list':
        draft[f.name] = Array.isArray(v) ? v.join('\n') : '';
        break;
      case 'number-list':
        draft[f.name] = Array.isArray(v) ? v.join(', ') : '';
        break;
      case 'multiselect':
        draft[f.name] = Array.isArray(v) ? v.map(String) : [];
        break;
      case 'custom':
        draft[f.name] = Array.isArray(v) ? v.map(String) : v == null ? '' : String(v);
        break;
      case 'number':
        // En el alta los números obligatorios salen vacíos (no se inventan ceros).
        draft[f.name] = options.blankNumbers || v == null ? '' : String(v);
        break;
      default:
        draft[f.name] = v === undefined || v === null ? '' : String(v);
    }
  }
  return draft;
}

/**
 * Borrador → valores. Parte de `base` (para conservar lo que el formulario no edita).
 * Un texto que no es número se deja tal cual para que el schema muestre su mensaje.
 */
export function fromDraft<T>(
  draft: Draft,
  fields: readonly FieldDef<T>[],
  base: Record<string, unknown> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  const groups = new Map<string, { nullable: boolean; props: Record<string, unknown> }>();
  for (const f of fields) {
    if (f.group) {
      const g = groups.get(f.group.key) ?? { nullable: false, props: {} };
      g.nullable ||= f.group.nullable === true;
      g.props[f.group.prop] = typeof draft[f.name] === 'string' ? draft[f.name] : '';
      groups.set(f.group.key, g);
      continue;
    }
    if (f.visibleWhen && !f.visibleWhen(draft)) {
      out[f.name] = 'hiddenValue' in f ? f.hiddenValue : neutralValue(f.kind);
      continue;
    }
    const v = draft[f.name];
    const text = typeof v === 'string' ? v : '';
    switch (f.kind) {
      case 'number':
        out[f.name] = parseNumber(text) ?? text;
        break;
      case 'nullable-number':
        out[f.name] = text.trim() === '' ? null : (parseNumber(text) ?? text);
        break;
      case 'list':
        out[f.name] = asLines(text);
        break;
      case 'number-list':
        out[f.name] = asTokens(text).map((t) => parseNumber(t) ?? t);
        break;
      default:
        out[f.name] = v;
    }
  }
  for (const [key, g] of groups) {
    const empty = Object.values(g.props).every((v) => String(v).trim() === '');
    out[key] = g.nullable && empty ? null : g.props;
  }
  return out;
}

function groupValue(values: Record<string, unknown> | null, group: { key: string; prop: string }) {
  const obj = values?.[group.key];
  return obj && typeof obj === 'object' ? (obj as Record<string, unknown>)[group.prop] : undefined;
}

/** Valor que se envía de un campo oculto (el borrador conserva su texto por si se vuelve a mostrar). */
function neutralValue(kind: FieldDef<unknown>['kind']): unknown {
  switch (kind) {
    case 'nullable-number':
      return null;
    case 'list':
    case 'number-list':
    case 'multiselect':
    case 'custom':
      return [];
    case 'checkbox':
      return false;
    default:
      return '';
  }
}
