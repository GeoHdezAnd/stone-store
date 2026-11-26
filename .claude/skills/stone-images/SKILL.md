---
name: stone-images
description: Genera texturas ilustrativas (no fotos) de las piedras del catálogo de Canteras Naturales (arenisca, caliza, recinto negro, cantera rosa, cantera blanca, laja, travertino, piedra bola) para tener imágenes de prueba en el sitio y el dashboard. Úsala cuando el dueño pida imágenes, fotos o texturas de los materiales, o cuando una piedra nueva no tenga foto.
---

# Imágenes de piedras (ilustrativas)

Claude no genera imágenes raster por sí mismo. Esta skill usa un script local (SVG + `sharp`, ya instalado en `services/api`) que dibuja una textura aproximada por piedra. Son **ilustraciones de respaldo para un proyecto académico con datos ficticios**: nunca las presentes como fotos reales del producto.

## Pasos

1. **Generar** (desde la raíz del repo; sin red, sin costo):

   ```bash
   npx tsx .claude/skills/stone-images/generate.ts                 # todas
   npx tsx .claude/skills/stone-images/generate.ts arenisca laja   # solo algunas
   ```

   Salida: `.generated/stone-images/<id>/<id>-1.jpg` (1600x1200, determinista por semilla).

2. **Revisar** cada imagen con `Read` antes de dar por buena una receta. Si una textura no se parece a la piedra, ajusta su receta en `LOOKS` (colores, frecuencia de manchas, estratos, poros) y vuelve a generarla.

3. **Subirlas** (las corre el dueño; Floci o AWS real): desde el dashboard (Piedras → editar → fotos), que usa URLs prefirmadas y valida tipo y tamaño (JPEG/PNG/WebP, máx. 5 MiB). Después:
   - Floci no dispara la Lambda `MediaVariants`: correr `npx tsx scripts/media-backfill.ts` (dry-run) y luego `--apply`.
   - Pulsar **Publicar** en el dashboard para que entren a `catalog.json`.
   - Ver `docs/levantar-y-probar.md` 9.1 para servirlas en el sitio local.

## Piedra nueva

Agrega una entrada en `LOOKS` de `generate.ts` con el mismo `id` que en `content/stones.json` y colores tomados de su campo `colores`. El script rechaza ids sin receta.

## Reglas

- No inventes que son fotos reales; en textos y commits di «ilustración» o «textura de ejemplo».
- No metas las imágenes generadas al repo sin que el dueño lo pida (`.generated/` es salida temporal).
- Los commits los hace el dueño: no ejecutes git que modifique el repo.
- Si el dueño quiere fotos realistas, el camino es una API de generación de imágenes de otro proveedor (requiere llave y costo) o fotos reales del patio; pregúntale antes.
