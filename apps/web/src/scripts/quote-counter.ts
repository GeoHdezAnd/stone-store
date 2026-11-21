import { getItems, onChange } from './quote-list';

// Contador «Cotización · N» del encabezado. Se actualiza al agregar o quitar piedras (misma
// pestaña) y por el evento `storage` (otras pestañas). El aviso para lectores de pantalla es
// discreto: solo se anuncia cuando el número CAMBIA, no al cargar la página.

const counters = document.querySelectorAll<HTMLElement>('[data-quote-count]');
const live = document.querySelector<HTMLElement>('[data-quote-live]');
let last = -1;

function render(announce: boolean): void {
  const n = getItems().length;
  if (n === last) return;
  last = n;
  counters.forEach((el) => {
    el.textContent = String(n);
  });
  if (announce && live) {
    live.textContent =
      n === 1 ? 'Tu cotización tiene 1 piedra' : `Tu cotización tiene ${n} piedras`;
  }
}

render(false);
onChange(() => render(true));
