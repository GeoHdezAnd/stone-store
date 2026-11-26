// Datos de EJEMPLO válidos para las pruebas (solo soporte de tests; no se empaqueta en la Lambda).

/** Cuerpo válido de `PUT /admin/freight-config` (sin version, autor ni fecha: los fija el servidor). */
export function configBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ejemplo: true,
    origen: { lat: 19.1, lng: -97.62, nombre: 'Patio (ejemplo)' },
    camiones: [
      {
        id: 'camioneta',
        nombre: 'Camioneta',
        capacidadKg: 3500,
        base: 800,
        porKm: 12,
        minimo: 1500,
      },
      { id: 'torton', nombre: 'Torton', capacidadKg: 12000, base: 2000, porKm: 22, minimo: 3500 },
      { id: 'trailer', nombre: 'Tráiler', capacidadKg: 25000, base: 3500, porKm: 30, minimo: 6000 },
    ],
    margenRango: 0.1,
    recargoDescarga: 500,
    mermaPct: 0,
    idaYVuelta: false,
    zonasCubiertas: ['72', '73', '74'],
    maxKm: 350,
    resumenCambio: 'Tarifas de ejemplo',
    ...over,
  };
}

/** Fila de versión tal como se guarda (para sembrar el repositorio en memoria). */
export function storedRow(version: string, over: Record<string, unknown> = {}) {
  const { resumenCambio, ...rest } = configBody();
  return {
    version,
    ...rest,
    creadaPor: 'user-0',
    creadaAt: '2026-11-01T10:00:00.000Z',
    resumenCambio,
    ...over,
  };
}

/** Piedra válida (vendida por m² a 5 cm; la densidad da 110 kg/m²). */
export function stoneRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'arenisca',
    nombre: 'Arenisca',
    origen: 'Sedimentaria',
    tipoRoca: 'Roca sedimentaria',
    colores: ['Beige'],
    categoriasUso: ['fachadas'],
    acabados: ['Labrado'],
    formatos: ['Bloque'],
    espesoresCm: [5],
    absorcionPct: 4.2,
    descripcion: '',
    existencia: 'En patio',
    entregaDias: 7,
    vendidaPor: ['m2'],
    pesoKgPorPieza: null,
    densidadKgM3: 2200,
    fotos: [],
    proyectosRelacionados: [],
    activa: true,
    ...over,
  };
}
