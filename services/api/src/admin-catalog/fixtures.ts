// Datos de EJEMPLO válidos para las pruebas (solo soporte de tests; no se empaqueta en la Lambda).
import type { CatalogItem } from './repository';

export function stone(over: Record<string, unknown> = {}): CatalogItem {
  return {
    id: 'arenisca',
    nombre: 'Arenisca',
    origen: 'Sedimentaria',
    tipoRoca: 'Roca sedimentaria',
    colores: ['Beige'],
    usos: ['Fachada'],
    categoriasUso: ['fachadas'],
    acabados: ['Labrado'],
    formatos: ['Bloque'],
    espesoresCm: [5],
    absorcionPct: 4.2,
    descripcion: '',
    existencia: 'En patio',
    entregaDias: 7,
    vendidaPor: ['m2'],
    pesoKgPorM2PorCm: null,
    pesoKgPorPieza: null,
    densidadKgM3: 2200,
    fotos: [],
    proyectosRelacionados: [],
    activa: true,
    ...over,
  } as CatalogItem;
}

export function project(over: Record<string, unknown> = {}): CatalogItem {
  return {
    id: 'casa-tepeyahualco',
    titulo: 'Casa Tepeyahualco',
    categoria: 'fachadas',
    ubicacion: 'Puebla, Puebla',
    anio: 2024,
    descripcion: '',
    superficie: '210 m²',
    piedras: [],
    acabados: [],
    piezasLabradas: null,
    entrega: '6 semanas',
    testimonio: null,
    fotos: [],
    estado: 'publicado',
    activa: true,
    ...over,
  } as CatalogItem;
}

export function finish(over: Record<string, unknown> = {}): CatalogItem {
  return {
    id: 'apomazado',
    nombre: 'Apomazado',
    descripcion: 'Superficie lisa y mate.',
    foto: null,
    activa: true,
    ...over,
  } as CatalogItem;
}

export function service(over: Record<string, unknown> = {}): CatalogItem {
  return {
    id: 'piedra-en-bruto',
    titulo: 'Piedra en bruto',
    descripcion: 'Bloques sin labrar.',
    activa: true,
    ...over,
  } as CatalogItem;
}
