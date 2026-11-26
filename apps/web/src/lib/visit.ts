// «Agendar visita»: una visita no es una cotización, así que no pasa por el formulario. Abre
// WhatsApp con un mensaje prellenado (CLAUDE.md 5.1, paso 10). El número va sin «+» ni espacios.

const VISIT_MESSAGE = 'Hola, me gustaría agendar una visita.';

export function visitWhatsAppUrl(number: string): string {
  return `https://wa.me/${number}?text=${encodeURIComponent(VISIT_MESSAGE)}`;
}
