# Canteras Naturales — Plan de desarrollo (v1)

> Este archivo es el contexto del proyecto para Claude Code. Léelo completo antes de escribir código.
> El dueño del proyecto está **aprendiendo AWS**: explica brevemente cada servicio nuevo que uses, prefiere soluciones simples y baratas, y avanza por fases pequeñas que se puedan probar.

---

## 1. Qué es el proyecto

Sitio web de **Canteras Naturales**, una cantera familiar de San Salvador el Seco, Puebla, México. Extraen, labran y venden piedra natural (arenisca, caliza, recinto negro, cantera rosa, cantera blanca, laja, travertino, piedra bola) en bloque, placa, laja y pieza labrada. Entregan en Puebla, Tlaxcala, Veracruz y CDMX.

**La tienda NO cobra en línea en la v1.** El cliente arma una lista de piedras, indica su obra y recibe una **cotización** que incluye un **estimado de flete calculado automáticamente**. El pago en línea es una fase posterior.

Idioma del sitio y de los textos: **español de México**. Moneda: **MXN**.

**Proyecto académico:** el negocio es **ficticio** y el objetivo es aprender AWS y tener un proyecto de portafolio. Todos los datos (clientes, precios, pesos, tarifas, métricas) son de ejemplo. No hay clientes reales: aun así, trata los datos personales como si lo fueran (buenas prácticas de seguridad y privacidad). Prioriza terminar un MVP (fases 1 a 4) antes de ampliar.

## 2. Objetivos de la v1

1. Sitio público rápido y responsivo (teléfono, tableta, escritorio) con catálogo de piedras y proyectos.
2. Lista de cotización (tipo carrito, sin precios).
3. Formulario de cotización que guarda la solicitud y avisa por correo al cliente y al dueño.
4. **Estimado de flete automático** según código postal, cantidad, peso y tipo de camión.
5. **Dashboard del dueño** (área privada con login) para gestionar solicitudes, catálogo, proyectos y tarifas de flete, y ver métricas (sección 5.3).
6. Todo desplegado en AWS, definido como código, con costo cercano a cero con poco tráfico.

### Fuera de alcance en v1 (no construir todavía)
- Pago en línea (Mercado Pago/Stripe) y pedidos.
- Cuentas de cliente / login de clientes.
- Inventario en tiempo real.
- Automatización de WhatsApp (solo un enlace `wa.me`).
- Roles complejos en el dashboard (en v1 solo `owner` y, opcional, `staff`).
- Reportes exportables avanzados / BI (basta con métricas simples y exportar CSV).

## 3. Diseño existente (fuente de verdad visual)

El diseño está en un artifact de Claude Design (proyecto "Natural stone store redesign"):
`https://claude.ai/code/artifact/5aa047c7-1585-4698-90ca-e9cfbf6ebbb7`

Archivos dentro del proyecto:
- `Canteras Naturales.dc.html` — el sitio real (una sola página con pantallas: inicio, servicios, catálogo, ficha de piedra, acabados, proyectos, detalle de proyecto, la cantera, contacto/cotización).
- `Canteras Naturales - móvil.dc.html` — vista de revisión a 390, 768 y 1280 px.
- `Dashboard.dc.html` — **diseño del dashboard del dueño** (prototipo interactivo con datos de ejemplo). Pantallas: Resumen, Solicitudes, Detalle de solicitud, Catálogo (con ficha de edición), Proyectos, Flete y tarifas (con simulador), Publicar, Configuración. Cada pantalla tiene el botón "Ver datos de esta pantalla" que lista las tablas y campos que necesita: **es la referencia para el modelo de datos** (ver 5.5). Usa el mismo sistema de diseño que el sitio.
- `Pietra Massa.dc.html` — **concepto distinto, ignorar**.
- `_ds/modernist-.../styles.css` — sistema de diseño (variables CSS `--color-*`, `--font-heading`, clases `.btn`, `.input`, `.field`, `.tag`, `.table`, `.seg`).

Reglas al convertirlo a código de producción:
- Conservar el look: tipografía, colores, espaciados, cuadrícula y las dos vistas del catálogo (Fichas / Índice) y de la ficha (Ficha / Editorial).
- Accesibilidad: `<button>`, `<a href>`, `<label for>` reales; contraste mínimo 4.5:1; `aria-label` en botones de solo ícono; teclado completo.
- Imágenes: el diseño tiene "image-slot" (zonas para subir foto). En producción serán `<img>` servidas desde S3/CloudFront con `srcset` y `loading="lazy"`.
- El estimado de flete del diseño usa **cifras de ejemplo**; en producción viene de la API (sección 7).

## 4. Stack recomendado

| Capa | Elección | Nota |
|---|---|---|
| Frontend público | **Astro** (HTML estático, islas de JS donde haga falta) — decidido | Desde la fase 4: loader de build que lee `catalog.json` publicado en S3 desde el dashboard (ver 6.1), con `content/` como respaldo. Un cambio publicado dispara un rebuild. |
| Dashboard del dueño | **SPA en Vite + React + TypeScript** (app separada en `apps/admin`) | Servida desde su propio origen/ruta (`admin.<dominio>`), `noindex`, tablas con TanStack Table, gráficas con Recharts o similar. |
| Autenticación | **Amazon Cognito** (User Pool + grupos `owner`, `staff`) | Login con correo y contraseña + MFA (TOTP) obligatorio para `owner`. API protegida con JWT authorizer de API Gateway. |
| Lenguaje | **TypeScript** en todo — decidido (Java descartado para el MVP) | Frontend, Lambdas e infra. Ejecutar TS con `tsx` (no `ts-node`, que falla con TypeScript 7). |
| Backend | **AWS Lambda** (runtime `nodejs22.x` o superior; `nodejs20.x` está deprecado) + **API Gateway HTTP API** | Una Lambda por **recurso** de la API de administración (con un router interno por método y ruta); los endpoints públicos sin autenticación (`freight-estimate`, `quotes-create`) conservan una Lambda propia. Lógica de dominio pura en `packages/shared`; clientes AWS en `services/api/src/lib` (ver 9). |
| Base de datos | **DynamoDB** (on-demand) | Ver sección 6. |
| Imágenes/estáticos | **S3 + CloudFront** | OAC (Origin Access Control), nunca bucket público directo. |
| Dominio/HTTPS | **Route 53 + ACM** (certificado en us-east-1 para CloudFront) | Opcional y apagado por defecto (flag de contexto CDK): en la fase 1 se usa el dominio `*.cloudfront.net`. Se activa cuando haya dominio. |
| Correo | **Amazon SES** | Verificar dominio (DKIM/SPF). Empezar en sandbox y pedir salida de sandbox. |
| Distancia/ruta | **Amazon Location Service** (Routes; Places para geocodificar) | Alternativa barata: tabla de códigos postales con lat/lng en DynamoDB (ver 7.2). |
| Anti-spam | Honeypot + Cloudflare Turnstile (o reCAPTCHA) + throttling de API Gateway | |
| Infra como código | **AWS CDK (TypeScript)** | Un stack por área (ver sección 9). |
| CI/CD | **GitHub Actions** → `cdk deploy` + sync a S3 + invalidación de CloudFront | OIDC hacia AWS, sin llaves largas. |
| Observabilidad | CloudWatch Logs/Alarms + **AWS Budgets** | Alerta de gasto desde el día 1. |

Región por defecto: **us-east-1** (más servicios, menor costo). Documentar cualquier cambio.

## 5. Flujo de la tienda (de punta a punta)

### 5.1 Flujo del cliente
1. Entra al sitio → ve inicio, servicios, piedras y proyectos.
2. En **Catálogo** filtra por uso (Pisos, Fachadas, Cubiertas de cocina, Escultura y ornamento, Exteriores y jardín, Muros y sillería) y abre la **ficha** de una piedra.
3. En la ficha elige acabado (según la piedra) y pulsa **"Agregar a cotización"**. El contador "Cotización · N" del encabezado sube. La lista se guarda en `localStorage` (con try/catch; el sitio debe funcionar sin él).
4. Abre **Cotización** (contacto). Ve su lista de piedras y llena: nombre, WhatsApp/teléfono, correo, lugar de la obra, **código postal**, para qué es, **cantidad + unidad** (m², piezas, toneladas) y notas.
5. Al tener CP válido (5 dígitos) y cantidad > 0, el sitio llama a `POST /freight/estimate` y muestra el **estimado de flete**: rango en MXN, peso aproximado, distancia, camión y viajes. Siempre con la leyenda "estimado sujeto a confirmación".
6. Pulsa **"Enviar solicitud"** → `POST /quotes`. Ve una pantalla de confirmación con su folio (ej. `CN-2026-00042`).
7. Recibe un correo de confirmación con el resumen y el estimado de flete. El dueño recibe un correo con todos los datos.
8. El dueño revisa, fija precios y flete final y responde por correo/WhatsApp (en menos de 48 h, promesa del sitio).
9. Alternativa: botón **"Escribir por WhatsApp"** abre `https://wa.me/52XXXXXXXXXX?text=...` con un mensaje prellenado (piedras + CP + cantidad).
10. Otra acción: **"Agendar visita al patio"** (en v1, lleva al formulario con motivo "visita" o a WhatsApp; no hay calendario).

### 5.2 Flujo del dueño (con dashboard)
1. Recibe correo por cada solicitud nueva (SES) con un enlace directo al detalle en el dashboard.
2. Entra al dashboard (login + MFA) → ve solicitudes nuevas arriba.
3. Abre una solicitud: ve cliente, obra, piedras, cantidades y el **estimado de flete automático**.
4. Captura precios por piedra y el **flete final** (puede aceptar el estimado o ajustarlo), añade notas internas y cambia el estado.
5. Pulsa **"Enviar cotización"** → el sistema manda un correo (SES) al cliente con la cotización final y vigencia; el estado pasa a `enviada`. (Opcional: botón "Responder por WhatsApp" con mensaje prellenado.)
6. Marca el resultado: `ganada` / `perdida` (con motivo).
7. Cuando cambia el catálogo (piedras, fotos, proyectos) o las tarifas, lo edita en el dashboard y pulsa **"Publicar"**: el sitio público se actualiza sin deploy de código.

### 5.3 Dashboard del dueño — módulos
Ruta base `admin.<dominio>`; todo en español; responsivo (el dueño lo usará desde el teléfono).

1. **Inicio / Resumen**: tarjetas con solicitudes nuevas hoy y esta semana, pendientes de responder (con alerta si pasan de 48 h), cotizadas, ganadas del mes, valor cotizado vs. ganado; gráfica de solicitudes por semana; top piedras solicitadas; mapa o tabla de zonas (estado/municipio por CP).
2. **Solicitudes**: tabla con búsqueda (folio, nombre, teléfono, CP), filtros (estado, rango de fechas, piedra, zona), orden y paginación; **vista de detalle** con línea de tiempo (cambios de estado, notas, correos enviados), edición de precios/flete final, notas internas, acciones (cambiar estado, enviar cotización, abrir WhatsApp, duplicar, archivar) y exportar CSV.
3. **Catálogo (piedras)**: alta/edición/baja lógica (`activa`), subida de fotos a S3 con URL prefirmada y orden de fotos, campos de la ficha (6.1), peso/densidad para el flete, "vista previa" antes de publicar.
4. **Proyectos**: CRUD con fotos, piedras usadas, testimonio.
5. **Acabados y servicios**: CRUD simple.
6. **Flete y tarifas**: editar camiones, tarifa base/por km/mínimo, margen del rango, zonas cubiertas, recargo de descarga; **versionado** (cada guardado crea versión, la activa se marca); **simulador** (CP + piezas → muestra el estimado sin crear solicitud).
7. **Configuración**: datos del patio (dirección, lat/lng, horario), teléfono/WhatsApp, correo remitente, plantillas de correo (texto editable con variables), usuarios (invitar `staff`).
8. **Publicar**: botón que genera `catalog.json` desde DynamoDB, lo sube a S3 y pide invalidación en CloudFront; muestra fecha de la última publicación y permite revertir a la anterior (versiones en S3).

Reglas del dashboard: nunca mostrar datos de clientes sin sesión válida; registrar **auditoría** (quién cambió qué y cuándo) en cada escritura; confirmar acciones destructivas; estados de carga/errores claros; accesible por teclado.

### 5.4 Estados de una solicitud
`nueva` → `en_revision` → `cotizada` → `enviada` → `ganada` | `perdida` | `cancelada`

### 5.5 Reglas de datos que salieron del diseño del dashboard
Decisiones tomadas al diseñar `Dashboard.dc.html`; el modelo de la sección 6 debe respetarlas.

- **Solicitud (detalle)**: el dueño captura `precioUnitario` por cada piedra (subtotal = cantidad × precio), `fleteFinal` (puede aceptar el estimado o ajustarlo) y `vigenciaDias` (por defecto **15**). Total = piedra + flete. **IVA: pendiente de definir**; por ahora el total se muestra "sin IVA" y `finalQuote.ivaPct` es opcional (null = no aplica).
- **Estado "perdida"** exige `lostReason` (lista sugerida: precio de la piedra, precio del flete, tiempo de entrega, eligió otro proveedor, sin respuesta, otro).
- **Historial** de cada solicitud: cada cambio de estado, nota interna, envío de correo y edición de precios agrega una entrada `{at, by, tipo, texto}`. Las notas internas nunca se envían al cliente.
- **Estimado vs. final**: se conservan ambos (`freight` automático y `finalQuote.fleteFinal`) y la `versionTarifa` con la que se estimó.
- **Piedra**: el peso por m² se **deriva** de `densidadKgM3` (peso por m² a 5 cm = densidad ÷ 100 × 5). `existencia` toma valores como "En patio" o "Bajo pedido". `vendidaPor` es una lista (m², pieza, tonelada). `activa` controla si aparece en el sitio.
- **Proyecto**: tiene `estado` (`publicado` | `borrador`); solo los publicados entran a `catalog.json`.
- **Tarifas de flete**: versionadas; cada guardado crea una versión nueva y una sola está activa. Incluyen `mermaPct` (merma y embalaje) y `maxKm`. El simulador del dashboard usa exactamente la misma función de cálculo que la API pública (código compartido en `packages/shared`; el simulador del dashboard puede además llamar a `POST /admin/freight/simulate`).
- **Métricas** (pantalla Resumen): solicitudes nuevas/por atender, cotizadas y ganadas del mes con su valor, tiempo promedio de respuesta (meta < 48 h), solicitudes por semana (últimas 8), piedras más solicitadas (30 días), embudo del mes y solicitudes por zona (estado a partir del CP).
- **Publicar**: lista de cambios pendientes desde la última publicación (a partir de `AuditLog`), publicación con versión (`v12`, etc.) y reversión a una versión anterior.
- **Configuración**: `Settings` guarda nombre del patio, dirección, lat, lng, horario, WhatsApp, correo remitente y plantilla del correo (variables: nombre, folio, piedras, flete, total, vigencia). Usuarios: correo, rol (`owner` | `staff`), MFA, último acceso (vienen de Cognito).
- **Exportar CSV** de solicitudes respetando los filtros activos.

## 6. Datos a almacenar

### 6.1 Contenido de catálogo
**Fuente de verdad: DynamoDB** (tablas `Stones`, `Projects`, `Finishes`, `Services`), editada desde el dashboard. Al pulsar "Publicar", una Lambda genera `catalog.json` (piedras, acabados, proyectos, servicios, configuración pública) y lo sube a S3 (`published/catalog.json`, con versiones); el sitio público lo lee con caché de CloudFront. El repo `content/` solo guarda el **seed inicial** (JSON) que un script carga a DynamoDB la primera vez.

**Stone (piedra)**
```json
{
  "id": "arenisca",
  "nombre": "Arenisca",
  "origen": "Sedimentaria",
  "tipoRoca": "Roca sedimentaria",
  "colores": ["Beige", "Crema", "Albero"],
  "categoriasUso": ["fachadas", "muros-silleria"],
  "acabados": ["Labrado", "Cepillado", "Rústico"],
  "formatos": ["Bloque", "Placa 60 × 40", "Corte a medida"],
  "espesoresCm": [3, 5, 8],
  "absorcionPct": 4.2,
  "descripcion": "…",
  "existencia": "En patio, San Salvador el Seco",
  "entregaDias": 7,
  "vendidaPor": ["m2", "pieza", "tonelada"],
  "pesoKgPorM2PorCm": 22,
  "pesoKgPorPieza": null,
  "densidadKgM3": 2200,
  "fotos": ["stones/arenisca/1.jpg"],
  "proyectosRelacionados": ["casa-tepeyahualco", "atrio-nopalucan"],
  "activa": true
}
```
> Dato crítico para el flete: **peso**. Para placa: `densidadKgM3 × espesor × área`. Para bloque: por tonelada o volumen. Para pieza labrada: `pesoKgPorPieza`. Los pesos del diseño (ej. 110 kg/m² a 5 cm) son de ejemplo hasta que el dueño dé los reales.

**Acabado (finish)**: `id`, `nombre`, `descripcion`, `foto`. (Corte de sierra, Apomazado, Cincelado, Martelinado, Arenado, Envejecido, Labrado, Cepillado, Rústico.)

**Project (proyecto)**: `id`, `titulo`, `categoria` (fachadas, cocinas, restauracion, jardin-exterior, escultura), `ubicacion`, `anio`, `descripcion`, `superficie`, `piedras[]`, `acabados[]`, `piezasLabradas`, `entrega`, `testimonio {texto, autor}`, `fotos[]`, `estado` (`publicado` | `borrador`).

**Service**: `id`, `titulo`, `descripcion`. (Piedra en bruto, Cocinas y fachadas, Piezas labradas, + los 7 que indica el sitio.)

### 6.2 Tablas DynamoDB (on-demand)

**`Quotes`** — solicitudes de cotización
| Campo | Tipo | Nota |
|---|---|---|
| `quoteId` (PK) | string | ULID. |
| `folio` | string | `CN-AAAA-NNNNN`, legible, único (contador atómico en `Counters`). |
| `createdAt` | ISO string | GSI por fecha: `gsi1pk = "STATUS#<estado>"`, `gsi1sk = createdAt`. |
| `status` | enum | Ver 5.4. |
| `customer` | map | `nombre`, `telefono`, `correo`. |
| `works` | map | `lugar`, `codigoPostal`, `uso`, `notas`. |
| `items[]` | list | `{stoneId, nombre, acabado, cantidad, unidad, pesoKg}` por piedra. |
| `freight` | map | `estimadoMin`, `estimadoMax`, `moneda`, `pesoTotalKg`, `distanciaKm`, `camion`, `viajes`, `versionTarifa`, `calculadoAt`. |
| `finalQuote` | map | `items[{stoneId, precioUnitario, subtotal}]`, `fleteFinal`, `subtotal`, `iva` (si aplica), `total`, `vigenciaDias`, `enviadaAt`. Lo llena el dueño en el dashboard. |
| `history[]` | list | Línea de tiempo: `{at, by, tipo (estado/nota/correo/edicion), de, a, texto}`. |
| `notes[]` | list | Notas internas `{at, by, texto}` (nunca visibles al cliente). |
| `lostReason` | string | Motivo si queda `perdida`. |
| `respondedAt` | ISO string | Primera respuesta al cliente (para medir tiempo de respuesta). |
| `consentAt` | ISO string | Aceptó aviso de privacidad. |
| `source` | map | `userAgent` recortado, referrer. Sin datos sensibles. |
| `ttl` | number (opc.) | Purga de solicitudes perdidas antiguas, si se decide. |

**`FreightConfig`** — tarifas y camiones (una fila por versión; la activa se marca)
- `version`, `activa`, `origen {lat, lng, nombre}` (el patio), `camiones[]` (`id`, `nombre`, `capacidadKg`, `base`, `porKm`, `minimo`), `margenRango` (±%), `recargoDescarga`, `mermaPct`, `zonasCubiertas[]` (estados/rangos de CP), `maxKm`, `creadaPor`, `creadaAt`, `resumenCambio`.

**`PostalCodes`** (opcional pero recomendada para ahorrar llamadas): `cp` (PK), `estado`, `municipio`, `colonia`, `lat`, `lng`. Cargar desde el catálogo SEPOMEX (script de importación).

**`Counters`**: `name` (PK), `value` (para el folio).

**`AuditLog`**: `pk = "ENTITY#<tipo>#<id>"`, `sk = "<ISO timestamp>#<requestId>"` (único por petición y ordenable por tiempo; el `requestId` evita colisiones en el mismo milisegundo), `userId`, `accion`, `antes`, `despues`. Escrito por toda API de admin, en la misma transacción que la escritura que audita. Límite conocido del MVP: `antes` viene de una lectura previa a la transacción, así que bajo escrituras simultáneas sobre el mismo registro puede quedar desfasado.

**`Settings`**: una fila `PUBLIC` (patio, horario, WhatsApp, textos) y una `MAIL` (plantillas de correo con variables).

**`Publications`**: `version`, `publishedAt`, `publishedBy`, `s3Key` (para revertir).

**Métricas**: calcularlas con consultas sobre `Quotes` (GSI por estado/fecha) y, si crece, una Lambda diaria que guarde agregados en `Metrics` (`fecha`, `nuevas`, `cotizadas`, `ganadas`, `valorCotizado`, `valorGanado`, `porPiedra`, `porZona`, `tiempoRespuestaHoras`).

**`Stones`, `Projects`** (fase 2, el catálogo vive en DB desde el inicio): mismos campos que 6.1.

### 6.3 Archivos en S3
- Bucket `site-<env>`: sitio estático.
- Bucket `media-<env>`: fotos originales + variantes (WebP/AVIF, 480/960/1600 px). Estructura `stones/<id>/…`, `projects/<id>/…`.
- Todo detrás de CloudFront con OAC; bucket privado.

### 6.4 Privacidad (México, LFPDPPP)
- Casilla obligatoria "Acepto el aviso de privacidad" en el formulario + página `/aviso-de-privacidad`.
- Guardar solo lo necesario. No registrar teléfono/correo completos en logs. Cifrado en reposo (DynamoDB y S3 por defecto).

## 7. Estimado de flete automático

### 7.1 Endpoint
`POST /freight/estimate`
```json
// request
{ "codigoPostal": "74000", "items": [{ "stoneId": "arenisca", "cantidad": 210, "unidad": "m2", "espesorCm": 5 }] }

// response 200
{
  "estimadoMin": 7200, "estimadoMax": 8800, "moneda": "MXN",
  "pesoTotalKg": 23100, "distanciaKm": 62,
  "camion": "Tráiler", "viajes": 1,
  "versionTarifa": "2026-11-01",
  "aviso": "Estimado sujeto a confirmación."
}
// errores: 400 (CP o cantidad inválidos), 422 (fuera de zona de cobertura), 429 (throttle), 502 (falla de geocodificación/ruta)
```
Validar con **zod** (CP `^\d{5}$`, cantidad > 0 y con tope razonable, unidad en el enum, `stoneId` existente). Nunca confiar en el peso enviado por el navegador: **el servidor lo calcula** desde `content/`/DB.

### 7.2 Algoritmo
1. **Peso**: por ítem según unidad. m² → `densidad × (espesor/100) × m²` (o `pesoKgPorM2PorCm × espesor × m²`); pieza → `pesoKgPorPieza × n`; tonelada → `n × 1000`. Sumar y agregar % de merma/tarima/embalaje (config).
2. **Origen/destino**: origen fijo (patio). Destino: lat/lng del CP desde `PostalCodes` (preferido, gratis) o Location Service Places (`SearchText` con "CP, México").
3. **Distancia por carretera**: Location Service **Routes** (`CalculateRoutes`, modo camión si está disponible, si no auto) origen→destino. Cachear resultado por CP en DynamoDB (`RouteCache`, TTL 90 días) para no repetir llamadas.
4. **Camión y viajes**: elegir el camión de menor costo que cubra el peso; si excede el mayor, dividir en viajes del camión más grande.
5. **Costo**: `max(minimo, base + distanciaKm × porKm) × viajes + recargoDescarga`. Considerar ida y vuelta si el dueño así lo cobra (parámetro).
6. **Rango**: `estimado ± margenRango%`, redondeado a $50.
7. Registrar `versionTarifa` para poder auditar cotizaciones viejas.
8. Si el CP está fuera de `zonasCubiertas` o `maxKm` → 422 con mensaje "consúltenos por WhatsApp".

> Las tarifas reales **no existen todavía**. Pedírselas al dueño (ver sección 12) y mientras tanto usar un `FreightConfig` de ejemplo claramente marcado como `ejemplo: true`.

### 7.3 Pruebas obligatorias del cálculo
Tests unitarios con casos: 1 m², 210 m² (varios viajes), tonelada, mezcla de piedras, CP inválido, CP fuera de zona, camión límite exacto, redondeo, tarifa mínima. Sin llamar a AWS (mockear Location Service).

## 8. API (HTTP API de API Gateway)

| Método y ruta | Descripción |
|---|---|
| `POST /freight/estimate` | Estimado de flete (7.1). Pública, con throttling. |
| `POST /quotes` | Crea solicitud: valida con zod, verifica Turnstile, recalcula flete en servidor, guarda, genera folio, manda correos (SES). Devuelve `{ folio }`. |
| `GET /quotes/{folio}` (opcional) | Consulta de estado con folio + correo. Fase posterior. |
| `GET /health` | Comprobación simple. |

**API de administración** (prefijo `/admin`, **todas** con JWT authorizer de Cognito; verificar grupo `owner`/`staff` en cada Lambda **y en cada ruta de su router interno**: el permiso se decide por ruta y método, no por Lambda):

| Método y ruta | Descripción |
|---|---|
| `GET /admin/quotes?status=&q=&from=&to=&cursor=` | Lista paginada con filtros. |
| `GET /admin/quotes/{quoteId}` | Detalle con historial y notas. |
| `PATCH /admin/quotes/{quoteId}` | Cambiar estado, precios, flete final, motivo de pérdida (valida transiciones permitidas). |
| `POST /admin/quotes/{quoteId}/notes` | Agregar nota interna. |
| `POST /admin/quotes/{quoteId}/send` | Enviar cotización final al cliente (SES) y marcar `enviada`. |
| `GET /admin/quotes/export.csv` | Exportar con los filtros actuales. |
| `GET /admin/metrics?from=&to=` | Datos del resumen. |
| `GET/POST/PUT/DELETE /admin/stones`, `/admin/projects`, `/admin/finishes`, `/admin/services` | CRUD del catálogo (borrado lógico). |
| `POST /admin/media/upload-url` | Devuelve URL prefirmada de S3 (valida tipo y tamaño). |
| `GET/PUT /admin/freight-config` | Ver versiones / crear nueva versión de tarifas. |
| `POST /admin/freight/simulate` | Simulador de flete. |
| `GET/PUT /admin/settings` | Configuración y plantillas de correo. |
| `POST /admin/publish` · `GET /admin/publications` · `POST /admin/publications/{version}/revert` | Publicar y revertir `catalog.json`. |
| `POST /admin/users/invite` | Invitar usuario `staff` (Cognito AdminCreateUser). |

Requisitos transversales: CORS solo al dominio del sitio; límites de tamaño de body; throttling por IP/etapa; respuestas de error sin filtrar detalles internos; logs estructurados JSON con `requestId` (sin datos personales completos).

**Correos (SES)**: plantillas HTML + texto plano en español. 1) Confirmación al cliente (folio, resumen, estimado de flete, aviso de 48 h). 2) Aviso al dueño (todos los datos + enlace/consulta). Manejar rebotes/quejas (SNS → log).

## 9. Estructura del repo y de la infraestructura

```
canteras-naturales/
├─ CLAUDE.md                  # este archivo
├─ package.json               # npm workspaces: apps/*, packages/*, services/*, infra
├─ tsconfig.base.json         # TS estricto, sin emit (tsc solo verifica tipos)
├─ .nvmrc                     # Node 22 o superior (fijado)
├─ apps/web/                  # sitio público (Astro, estático)
│  ├─ src/pages, components, islands/
│  └─ public/
├─ apps/admin/                # dashboard del dueño (Vite + React + TS)
│  └─ src/pages: dashboard, quotes, quote-detail, stones, projects, freight, settings, publish
├─ packages/
│  ├─ shared/                 # DOMINIO PURO e isomórfico: schemas zod, tipos, cálculo de flete,
│  │                          # estados y transiciones de solicitud. SIN AWS SDK, sin I/O.
│  └─ ui/                     # tokens de diseño (styles.css), fuentes autoalojadas; lo usan web y admin
├─ content/                   # JSON seed inicial: stones, finishes, projects, services, settings (ejemplo)
├─ services/api/              # Lambdas (TypeScript), solo servidor
│  └─ src/
│     ├─ lib/                 # clientes AWS (DynamoDB, S3, SES), auth/roles, auditoría, logger
│     ├─ freight-estimate/
│     ├─ quotes-create/
│     └─ admin-*/             # una Lambda por recurso, con router interno: quotes, catalog (stones, projects, finishes, services),
│                             # media, freight-config, settings, metrics, publish, users
├─ infra/                     # AWS CDK (TypeScript)
│  └─ stacks: SiteStack (S3, CloudFront, [Route53, ACM opcionales]), ApiStack (API GW, Lambdas, IAM),
│              DataStack (DynamoDB), MediaStack (S3 de fotos), MailStack (SES), AuthStack (Cognito), AdminSiteStack (S3+CloudFront del dashboard),
│              ObservabilityStack (alarms, budgets)
├─ scripts/                   # importar CP, listar solicitudes, cargar FreightConfig
└─ .github/workflows/         # CI/CD
```

### 9.1 Reglas de arquitectura del repo
- **Dirección de dependencias** (nunca al revés): `apps/*` y `services/*` → `packages/*`. `packages/*` no depende de nada del repo ni del AWS SDK. `infra` no importa código de runtime (solo constantes/tipos de `packages/shared` si hace falta). Verificar con la regla de lint `no-restricted-imports`.
- **Por qué `packages/shared` y no `services/api/shared`:** web, admin y Lambdas necesitan los mismos schemas y tipos, y un frontend no debe empaquetar el AWS SDK ni depender de una carpeta de servidor. Lo que toca AWS vive en `services/api/src/lib`.
- **Paquetes internos:** `packages/*` se consumen directo desde el código fuente (`exports` → `src/index.ts`), sin paso de compilación previo. `tsc` solo verifica tipos (sin emitir); el empaquetado lo hacen Vite/Astro en los frontends y esbuild (`NodejsFunction`) en las Lambdas. `packages/*` no importa ningún paquete `@canteras/*` ni usa tipos de Node.
- **Salvaguarda de entorno:** `infra/lib/config.ts` impide mezclar Floci con AWS real (con `AWS_ENDPOINT_URL` solo vale la cuenta `000000000000`, y esa cuenta nunca se usa sin el endpoint); `APP_ENV` solo acepta `dev` o `prod`, y `prod` exige cuenta explícita.
- **Un stack por área, apilados por dependencia** (Data → Auth → Media → Api → Site). Los stacks pueden recibir un flag de contexto para apagar piezas no soportadas por el emulador (p. ej. dominio/ACM).
- **Despliegue del sitio:** `aws s3 sync` + invalidación desde CI (assets con hash `immutable`, HTML `no-cache`). No usar `BucketDeployment`: el contenido y la infra tienen ciclos de vida distintos (la fase 3 publica `catalog.json` fuera de CDK).
- **Entornos:** `dev` y `prod` (cuentas o al menos stacks separados por prefijo).
- **Permisos IAM** de **mínimo privilegio** por Lambda (solo las tablas/acciones que usa), vía `grant*` de CDK. Con una Lambda por recurso, el rol cubre únicamente las tablas de ese recurso y `AuditLog`; el aislamiento ya no es por endpoint, así que cada ruta del router debe verificar el rol y se prueba con tests. El rol de CI solo asume los roles de bootstrap de CDK (`cdk-*`) y tiene `s3 sync` + `cloudfront:CreateInvalidation`; ajustar la política de ejecución del bootstrap (`--cloudformation-execution-policies`) en lugar de dejar `AdministratorAccess`.
- **Etiquetar todo** con `Project=canteras-naturales`, `Env=<dev|prod>`.

### 9.2 Desarrollo local con Floci
- Emulador AWS local para las fases 1 a 4. AWS real solo en el **hito de salida** (después de la fase 4, ver sección 11), con un único smoke test de lo que Floci no cubre (DNS/ACM real, SES fuera de sandbox, caché y cabeceras reales de CloudFront, aplicación real de IAM, Location Service, Budgets).
- Levantar: `docker compose up -d` desde la raíz (usa `docker-compose.yml`, con el socket de Docker y un volumen de datos) y salud en `curl localhost:4566/_floci/health`. El socket de Docker es obligatorio (Lambda corre en contenedores). **El JWT authorizer solo funciona si Floci tiene una IP fija**: el compose crea una red con subred fija y `FLOCI_HOSTNAME` es una IP literal (`172.30.0.10`, constante `FLOCI_IP` en `infra/lib/config.ts`); con un nombre de host el authorizer responde 401 siempre.
- Variables solo para Floci: `AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1 AWS_ENDPOINT_URL=http://localhost:4566`; bootstrap con `npx cdk bootstrap aws://000000000000/us-east-1`. CDK respeta `AWS_ENDPOINT_URL`, no hace falta `cdklocal`.
- Límites conocidos: no ejecuta CloudFront Functions, no soporta `ResponseHeadersPolicy` custom vía CloudFormation, el JWT authorizer rechaza issuers privados salvo `FLOCI_SECURITY_ALLOW_PRIVATE_JWT_TARGETS=true`, **no aplica bucket policy ni BlockPublicAccess** (un GET sin firma a S3 devuelve 200) y la Lambda de `autoDeleteObjects` falla con `ECONNREFUSED` al puerto 443 (también con Compose). Por eso `SiteStack` apaga `autoDeleteObjects` cuando hay `AWS_ENDPOINT_URL` (`DeployEnv.emulated`) y el bucket se vacía a mano antes de `cdk destroy`. Probar la lógica de esas piezas con tests unitarios y verificarlas en AWS real, en el hito de salida. Verificar en ese smoke test: rechazo de lectura directa al bucket, OAC, `defaultRootObject`, validación DNS de ACM y alias de Route 53.
- Nunca usar credenciales reales con `AWS_ENDPOINT_URL` apuntando a Floci, ni al revés.
- `autoDeleteObjects: true` solo en `dev`; jamás en `prod`.

## 10. Calidad, seguridad y costos
- Lint + typecheck + tests en cada PR. Cobertura alta en `packages/shared` (flete y validaciones).
- **Sin tests en el frontend (decisión del dueño):** `apps/web` y `apps/admin` **no llevan pruebas** (ni unitarias, ni de componentes, ni e2e) y no se instalan dependencias de prueba en ellas (Vitest, Testing Library, jsdom, Playwright, etc.). La lógica que sí debe probarse vive en `packages/shared` (dominio puro) y en `services/*`, que mantienen sus tests. En el frontend la verificación es `typecheck`, `lint`, `prettier --check`, `build` y la prueba manual en el navegador (ver `docs/pruebas-locales.md`). No agregues tests al frontend aunque la tarea sea crítica (p. ej. la sesión); si algo del frontend parece pedir una prueba, avísame en vez de escribirla. Un fallo de autenticación en el navegador se cubre con la revisión adversarial y con la validación del servidor, que es quien autoriza.
- Sin secretos en el repo (usar SSM Parameter Store / Secrets Manager para claves de Turnstile, etc.).
- Dashboard: MFA para `owner`, sesiones con expiración corta, `noindex`/`robots` bloqueado, CORS restringido al origen del admin, validación de rol en **cada** Lambda (no solo en el frontend), PII protegida (no en logs, no en URLs), auditoría de escrituras.
- Cabeceras de seguridad en CloudFront (CSP, HSTS, X-Content-Type-Options).
- Lighthouse ≥ 90 en móvil (rendimiento y accesibilidad); imágenes optimizadas.
- **AWS Budgets** con alerta a USD 5/10 y alarma de errores de Lambda/5xx de API.
- Costo esperado con bajo tráfico: casi todo en capa gratuita; vigilar Location Service y SES fuera de sandbox.

## 11. Fases de trabajo (hacer en este orden, cada una desplegable)

> **Orden revisado:** el dueño prioriza el dashboard completo (catálogo y todo el manejo del negocio) sobre el sitio público: primero debe existir algo real sobre lo que trabajar. El dashboard no depende del sitio (solo de datos, autenticación, API y hosting), y el sitio público después consume lo que el dueño publique. El contenido de ejemplo no se discute: la prioridad es una base sólida conectable a AWS.

1. **Fundamentos e infraestructura de hosting**: **T0** repo y tooling (hecho), **T1** construct reutilizable de sitio estático y `SiteStack` en CDK probado en Floci (S3 privado + CloudFront con OAC, sin dominio propio) que publica una página provisional "En construcción", **T2** CI/CD con GitHub Actions y OIDC con aprobación manual (`CiStack`, `ci.yml`, `deploy.yml`: se prueba con tests de síntesis y en Floci, y `deploy.yml` queda **dormido** hasta el hito de salida a AWS real). El smoke test en AWS real (antes T3) se movió a ese hito. El mismo construct se reutiliza después en `AdminSiteStack`. *Aprender: S3, CloudFront, IAM, CDK, OIDC.*
2. **Autenticación y dashboard: catálogo y configuración** (prioridad del dueño): `DataStack` (`Stones`, `Projects`, `Finishes`, `Services`, `Settings`, `AuditLog`, `Publications`, `Counters`), script que carga el seed de `content/` a DynamoDB, Cognito (grupos + MFA), JWT authorizer, API de administración, `apps/admin` con los tokens de diseño en `packages/ui`, login, CRUD de piedras, proyectos, acabados y servicios con subida de fotos a S3 (URLs prefirmadas), configuración (patio, WhatsApp, plantillas) y auditoría de cada escritura. *Aprender: Cognito, authorizers, DynamoDB, IAM por rol, S3 presigned URLs.*
3. **Dashboard: publicar, tarifas y solicitudes**: `catalog.json` + botón Publicar/Revertir (versionado en S3, invalidación de CloudFront), editor de tarifas con versionado y simulador (`FreightConfig` de ejemplo), `Quotes` y `FreightConfig` en `DataStack`, lista y detalle de solicitudes, cambio de estado, notas, precios, flete final y "Enviar cotización" por SES. Mientras no exista el formulario público, las solicitudes se siembran con un script. *Aprender: versionado de S3, invalidaciones de CloudFront, SES.*
4. **Sitio público y formulario**: sitio Astro (inicio, catálogo, ficha de piedra con layout Ficha, placeholders "En construcción") que lee el `catalog.json` publicado desde el dashboard, lista de cotización en `localStorage`, API Gateway + Lambda `quotes-create` + SES, folio, validación, anti-spam y aviso de privacidad. Texto y botones con el acento oscuro `#ae1800`. *Aprender: Astro, Lambda, API Gateway.*

**Hito: salida a AWS real** (después de la fase 4, con el MVP probado en Floci; decisión del dueño): cuenta de AWS nueva (usuario administrador con MFA, `AWS Budgets` y perfil de CLI con nombre), bootstrap con política de ejecución acotada (`--cloudformation-execution-policies`), despliegue manual de `CiStack`, configuración de GitHub (environment `dev` con revisores y solo `main`, variables `AWS_ROLE_ARN` y `AWS_ACCOUNT_ID`), primer despliegue con `cdk diff` por delante y smoke test de lo que Floci no verifica (bucket policy y OAC, JWT authorizer de Cognito real, SES en sandbox, cabeceras de CloudFront, Location Service). *Aprender: bootstrap, IAM de mínimo privilegio, OIDC.*
5. **Flete automático**: `PostalCodes`, `freight-estimate`, Location Service, caché de rutas, UI del estimado en el formulario, estimado guardado en la solicitud. *Aprender: Location Service, diseño de reglas de negocio, pruebas.*
6. **Dashboard: métricas y operación**: resumen con gráficas, exportar CSV, alarmas, Budgets, optimización de imágenes (Lambda al subir a S3).
7. **Después**: pago en línea (Mercado Pago o Stripe) con Lambda + webhooks, pedidos y facturación.

## 12. Información pendiente del dueño (bloquea datos reales)
1. Cómo cobran el flete hoy: por km, por zona, por viaje o por tonelada; precios actuales y mínimo.
2. Camiones que usan y capacidad (t); si el costo es ida o ida y vuelta; si cobran descarga/maniobras.
3. Pesos reales o densidad por piedra y formato; espesores disponibles.
4. Dirección exacta del patio (lat/lng) y zonas de entrega (estados, CPs, distancia máxima).
5. Lista completa de las 18 piedras, 9 acabados, 7 servicios y proyectos con fotos.
6. Dominio deseado, correo remitente (ej. `ventas@canterasnaturales.mx`) y número de WhatsApp.
7. Texto del aviso de privacidad.
8. Quién usará el dashboard (correos para `owner` y `staff`), si usan IVA en las cotizaciones y cómo quieren el formato del correo de cotización final (logo, firma, condiciones, vigencia). *(Proyecto académico: decidir con valores de ejemplo y registrar la decisión en el README.)*
9. Qué métricas le importan más al dueño (ej. tiempo de respuesta, piedras más pedidas, zonas, conversión).

## 13. Cómo trabajar conmigo (instrucciones para Claude Code)
- Antes de cada fase, propón un plan corto y espera confirmación; al terminar, resume qué se creó y cómo probarlo.
- Explica en 2–3 líneas cada servicio de AWS la primera vez que aparezca (qué es, por qué aquí, costo aproximado).
- Cambios pequeños y revisables; un commit por unidad lógica con mensaje claro.
- No inventes tarifas, pesos ni datos del negocio: usa datos de ejemplo marcados como tales y avísame.
- No despliegues a `prod` ni crees recursos con costo sin avisarme antes. Siempre muestra `cdk diff` antes de `cdk deploy`.
- Si algo del diseño no está claro, abre el artifact de diseño y respétalo; si hay conflicto entre diseño y esta guía, pregúntame.
- **Commits:** los hago yo. No ejecutes comandos git que modifiquen el repo (`init`, `add`, `commit`, `push`); deja los cambios en el árbol de trabajo y, si ayuda, sugiere cómo partirlos en commits convencionales.

## 14. Idioma (español de México)
Esta regla **tiene prioridad** sobre el valor por defecto de escribir artefactos en inglés.
- **En español de México:** todo texto visible para personas (sitio, dashboard, correos, mensajes de error, etiquetas y textos de accesibilidad), comentarios en el código, README, documentación, nombres de pruebas (`describe`/`it`), mensajes de lint personalizados y respuestas en el chat (sin voseo: tuteo neutro mexicano).
- **En inglés:** identificadores (variables, funciones, tipos, componentes), nombres de archivos y carpetas, claves de JSON y de la API, nombres de campos de DynamoDB que ya están definidos en este documento, y nombres de recursos de AWS.
- Excepción: los valores del dominio que ya están en español en este documento (`nueva`, `en_revision`, `cotizada`, `enviada`, `ganada`, `perdida`, `cancelada`, `categoriasUso`, etc.) se conservan tal cual.
- Los mensajes de commit los redacta el dueño.
