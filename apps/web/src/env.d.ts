/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** URL base de las fotos (S3/CloudFront). Si falta, se usa `/media`. */
  readonly PUBLIC_MEDIA_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
