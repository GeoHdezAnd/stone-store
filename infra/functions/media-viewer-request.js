// CloudFront Function (runtime cloudfront-js-2.0), evento viewer-request, SOLO en /media/*.
// JS puro: CloudFront Functions no admite módulos (sin require/import/export).
//
// Solo deja pasar las VARIANTES WebP generadas por el servidor:
//   /media/<stones|projects|finishes>/<id>/<uuid v4 minúsculas>-<480|960|1600>w.webp
// Todo lo demás (originales .jpg/.png, rutas con .., %2e, //, mayúsculas, otras entidades...) da 404,
// aunque la política del bucket ya negaría los originales (defensa en profundidad).
// Si calza, quita el prefijo "/media" (la clave en S3 empieza en la entidad) y vacía la query.
var VARIANT_RE =
  /^\/media\/(stones|projects|finishes)\/[a-z0-9]+(?:-[a-z0-9]+)*\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-(480|960|1600)w\.webp$/;

// Tope de longitud: 5 + entidad + id (máx. 64) + uuid + sufijo caben de sobra en 260.
var MAX_URI_LENGTH = 260;

// CloudFront invoca `handler` por nombre; no se exporta (no hay módulos en este runtime).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (
    (request.method !== 'GET' && request.method !== 'HEAD') ||
    uri.length > MAX_URI_LENGTH ||
    !VARIANT_RE.test(uri)
  ) {
    return { statusCode: 404, statusDescription: 'Not Found' };
  }
  request.uri = uri.substring('/media'.length);
  request.querystring = {};
  return request;
}
