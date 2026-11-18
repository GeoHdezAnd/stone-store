# Datos de ejemplo (seed)

Todo lo de esta carpeta es **ficticio**: el negocio es un proyecto académico. Nombres, pesos, densidades, coordenadas, WhatsApp (`525500000000`) y correo (`example.com`) son inventados. Las coordenadas del patio son aproximadas. Los 4 servicios que no vienen de CLAUDE.md (corte a medida, entrega a obra, asesoría de obra, visita al patio) también son de ejemplo.

## Formato

Los esquemas de `packages/shared` son estrictos (no admiten campos extra), así que cada archivo trae un sobre que marca los datos como ejemplo:

```json
{ "ejemplo": true, "aviso": "Datos de ejemplo, no reales.", "items": [ ... ] }
```

- `stones.json`, `finishes.json`, `projects.json`, `services.json`: la lista va en `items`.
- `settings.json`: en lugar de `items` trae `public` (fila `PUBLIC`) y `mail` (fila `MAIL`).
- Cada item lleva `"activa": true` (baja lógica: el dashboard nunca borra, solo pone `activa` en `false`).
- Las piedras referencian acabados por **nombre**; los proyectos, por **id** (de piedra y de acabado).

## Cargarlos a DynamoDB

```sh
npx tsx scripts/seed.ts   # desde la raíz, después de desplegar canteras-data-<env>
```

El script valida todo (esquemas e integridad referencial) antes de escribir. **No sobrescribe**: usa `attribute_not_exists`, así que lo que edites en el dashboard se conserva y correrlo dos veces no cambia nada.
