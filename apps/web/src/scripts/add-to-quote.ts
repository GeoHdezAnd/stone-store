import { SOLD_BY_UNITS, type SoldByUnit } from '@canteras/shared';
import { addItem, getItems, isPersistent, type QuoteListItem } from './quote-list';

// Botón «Agregar a cotización» de la ficha de piedra. Sin JavaScript el botón queda deshabilitado.

const isUnit = (v: string): v is SoldByUnit => (SOLD_BY_UNITS as readonly string[]).includes(v);

document.querySelectorAll<HTMLElement>('[data-add-to-quote]').forEach((root) => {
  const stoneId = root.dataset['stoneId'] ?? '';
  const nombre = root.dataset['stoneName'] ?? '';
  const firstUnit = (root.dataset['units'] ?? '').split(',').find(isUnit);
  const button = root.querySelector<HTMLButtonElement>('button[data-add-button]');
  const finish = root.querySelector<HTMLSelectElement>('select[data-finish]');
  const status = root.querySelector<HTMLElement>('[data-add-status]');
  if (!button || stoneId === '') return;

  const say = (text: string) => {
    if (status) status.textContent = text;
  };
  const inList = () => getItems().some((i) => i.stoneId === stoneId);

  button.disabled = false;
  if (!isPersistent()) {
    const warning = root.querySelector<HTMLElement>('[data-persist-warning]');
    if (warning) warning.hidden = false;
  }
  if (inList()) say('Esta piedra ya está en tu lista de cotización.');

  button.addEventListener('click', () => {
    const item: QuoteListItem = { stoneId, nombre };
    if (finish && finish.value !== '') item.acabado = finish.value;
    if (firstUnit) item.unidad = firstUnit;
    const result = addItem(item);
    if (result === 'added') say('Agregada a tu lista de cotización.');
    else if (result === 'exists') say('Esta piedra ya está en tu lista de cotización.');
    else say('Tu lista está llena. Quita alguna piedra para agregar otra.');
  });
});
