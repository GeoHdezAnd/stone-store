import type { APIRoute } from 'astro';

// El formulario de cotización no se rastrea; el resto del sitio sí.
export const GET: APIRoute = ({ site }) => {
  const base = site ?? new URL('http://localhost:4321');
  const body = `User-agent: *\nAllow: /\nDisallow: /quote/\n\nSitemap: ${new URL('/sitemap.xml', base).href}\n`;
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
