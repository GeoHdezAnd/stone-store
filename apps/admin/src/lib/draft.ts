import { asRows } from '../components/fieldTypes';
import type { Draft, FieldDef, FormValue, RowFieldDef } from '../components/fieldTypes';

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

/** Evita ruido de coma flotante al escalar (0.07 × 100 = 7.000000000000001). */
const clean = (n: number) => Number(n.toFixed(6));

const numberToText = (v: unknown, scale: number) =>
  typeof v === 'number' ? String(clean(v * scale)) : v == null ? '' : String(v);

function groupValue(values: Record<string, unknown> | null, group: { key: string; prop: string }) {
  const obj = values?.[group.key];
  return obj && typeof obj === 'object' ? (obj as Record<string, unknown>)[group.prop] : undefined;
}

/** Valores guardados → borrador de formulario (todo texto, salvo casillas y listas de opciones). */
export function toDraft<T>(
  values: Record<string, unknown> | null,
  fields: readonly FieldDef<T>[],
  options: { blankNumbers?: boolean } = {},
): Draft {
  const draft: Draft = {};
  for (const f of fields) {
    const v = f.group ? groupValue(values, f.group) : values?.[f.name];
    const scale = f.scale ?? 1;
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
      case 'rows':
        draft[f.name] = rowsToDraft(v, f.rowFields ?? []);
        break;
      case 'custom':
        draft[f.name] = Array.isArray(v) ? v.map(String) : v == null ? '' : String(v);
        break;
      case 'number':
        // En el alta los números obligatorios salen vacíos (no se inventan ceros).
        draft[f.name] = options.blankNumbers ? '' : numberToText(v, scale);
        break;
      case 'nullable-number':
        draft[f.name] = numberToText(v, scale);
        break;
      default:
        draft[f.name] = v === undefined || v === null ? '' : String(v);
    }
  }
  return draft;
}

function rowsToDraft(v: unknown, rowFields: readonly RowFieldDef[]): FormValue {
  if (!Array.isArray(v)) return [];
  return v.map((row) => {
    const obj = (row ?? {}) as Record<string, unknown>;
    return Object.fromEntries(
      rowFields.map((rf) => [rf.name, obj[rf.name] == null ? '' : String(obj[rf.name])]),
    );
  });
}

/** Convierte el valor de UN campo del borrador al valor que espera el schema. */
function convert<T>(f: FieldDef<T>, v: FormValue | undefined): unknown {
  const text = typeof v === 'string' ? v : '';
  const scale = f.scale ?? 1;
  switch (f.kind) {
    case 'number': {
      const n = parseNumber(text);
      return n === undefined ? text : clean(n / scale);
    }
    case 'nullable-number': {
      if (text.trim() === '') return null;
      const n = parseNumber(text);
      return n === undefined ? text : clean(n / scale);
    }
    case 'list':
      return asLines(text);
    case 'number-list':
      return asTokens(text).map((t) => parseNumber(t) ?? t);
    case 'rows':
      return asRows(v).map((row) =>
        Object.fromEntries(
          (f.rowFields ?? []).map((rf) => {
            const raw = row[rf.name] ?? '';
            return [rf.name, rf.kind === 'number' ? (parseNumber(raw) ?? raw) : raw];
          }),
        ),
      );
    default:
      return v;
  }
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
      g.props[f.group.prop] = convert(f, draft[f.name]);
      groups.set(f.group.key, g);
      continue;
    }
    if (f.visibleWhen && !f.visibleWhen(draft)) {
      out[f.name] = 'hiddenValue' in f ? f.hiddenValue : neutralValue(f.kind);
      continue;
    }
    out[f.name] = convert(f, draft[f.name]);
  }
  for (const [key, g] of groups) {
    const empty = Object.values(g.props).every((v) => String(v).trim() === '');
    out[key] = g.nullable && empty ? null : g.props;
  }
  return out;
}

/** Valor que se envía de un campo oculto (el borrador conserva su texto por si se vuelve a mostrar). */
function neutralValue(kind: FieldDef<unknown>['kind']): unknown {
  switch (kind) {
    case 'nullable-number':
      return null;
    case 'list':
    case 'number-list':
    case 'multiselect':
    case 'rows':
    case 'custom':
      return [];
    case 'checkbox':
      return false;
    default:
      return '';
  }
}
