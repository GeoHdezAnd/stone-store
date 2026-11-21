/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** URL base de las fotos (S3/CloudFront). Si falta, se usa `/media`. */
  readonly PUBLIC_MEDIA_BASE_URL?: string;
  /** URL base de la API pública, sin «/» final (el formulario envía a `<url>/quotes`). Si falta, el formulario no envía. */
  readonly PUBLIC_API_URL?: string;
  /** Clave de sitio (pública) de Cloudflare Turnstile. El valor `test-pass` activa el modo simulado (Floci). */
  readonly PUBLIC_TURNSTILE_SITE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
