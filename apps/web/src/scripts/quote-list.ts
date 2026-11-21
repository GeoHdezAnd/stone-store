import { z } from 'zod';
import { MAX_ITEMS, SOLD_BY_UNITS } from '@canteras/shared';

// Lista de cotización del navegador (CLAUDE.md 5.1, paso 3). Solo corre en el cliente.
// `localStorage` puede faltar o lanzar (modo privado, datos bloqueados): TODO acceso va en try/catch
// y, si falla, la lista vive en memoria durante la visita. La lista NO guarda precios.

/** Clave versionada: si cambia la forma de los datos, se sube la versión y se ignora la anterior. */
export const STORAGE_KEY = 'canteras:quote-list:v1';
/** Evento de la misma pestaña (el evento `storage` solo llega a las OTRAS pestañas). */
const CHANGE_EVENT = 'canteras:quote-change';

const storedItemSchema = z.object({
  stoneId: z
    .string()
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  nombre: z.string().max(120),
  acabado: z.string().max(80).optional(),
  cantidad: z.number().positive().optional(),
  unidad: z.enum(SOLD_BY_UNITS).optional(),
  espesorCm: z.number().positive().optional(),
});
const storedListSchema = z.object({
  v: z.literal(1),
  items: z.array(storedItemSchema).max(MAX_ITEMS),
});

export type QuoteListItem = z.infer<typeof storedItemSchema>;
export type AddResult = 'added' | 'exists' | 'full';

// Copia en memoria: respaldo cuando no hay `localStorage`.
let memory: QuoteListItem[] = [];

function readStorage(): QuoteListItem[] | undefined {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed = storedListSchema.safeParse(JSON.parse(raw));
    // Datos corruptos o de otra forma: se tratan como lista vacía (no se rompe el sitio).
    return parsed.success ? parsed.data.items : [];
  } catch {
    return undefined; // sin acceso a localStorage
  }
}

export function getItems(): QuoteListItem[] {
  const stored = readStorage();
  if (stored !== undefined) {
    memory = stored;
    return stored.map((i) => ({ ...i }));
  }
  return memory.map((i) => ({ ...i }));
}

function save(items: QuoteListItem[]): void {
  memory = items;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, items }));
  } catch {
    // Sin almacenamiento: queda solo en memoria.
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export function addItem(item: QuoteListItem): AddResult {
  const items = getItems();
  if (items.some((i) => i.stoneId === item.stoneId)) return 'exists';
  if (items.length >= MAX_ITEMS) return 'full';
  save([...items, item]);
  return 'added';
}

export function removeItem(stoneId: string): void {
  save(getItems().filter((i) => i.stoneId !== stoneId));
}

export function updateItem(
  stoneId: string,
  patch: Partial<Pick<QuoteListItem, 'acabado' | 'cantidad' | 'unidad' | 'espesorCm'>>,
): void {
  save(getItems().map((i) => (i.stoneId === stoneId ? { ...i, ...patch } : i)));
}

export function clearItems(): void {
  save([]);
}

/** Cambios en esta pestaña y en las demás (para el contador). Devuelve la función que desuscribe. */
export function onChange(callback: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    // `key === null` es un `localStorage.clear()` desde otra pestaña.
    if (e.key === STORAGE_KEY || e.key === null) callback();
  };
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener('storage', onStorage);
  };
}

/** Solo cambios hechos en OTRAS pestañas (la página del formulario no debe redibujarse al teclear). */
export function onExternalChange(callback: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY || e.key === null) callback();
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}
