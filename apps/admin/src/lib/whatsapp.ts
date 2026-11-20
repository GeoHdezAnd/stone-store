/**
 * Teléfono para wa.me: solo dígitos con lada de país de México (52). Un número de 10 dígitos
 * recibe el 52; «521» + 10 dígitos (formato antiguo de celular) se reduce a «52» + 10.
 */
export function normalizeWhatsappPhone(raw: string): string {
  let digits = raw.replace(/\D/g, '').replace(/^00/, '');
  if (digits.length === 13 && digits.startsWith('521')) digits = `52${digits.slice(3)}`;
  if (digits.length === 10) digits = `52${digits}`;
  return digits;
}

/** Enlace de WhatsApp con el mensaje prellenado. No se registra en consola ni se guarda. */
export function whatsappLink(phone: string, message: string): string {
  return `https://wa.me/${normalizeWhatsappPhone(phone)}?text=${encodeURIComponent(message)}`;
}
