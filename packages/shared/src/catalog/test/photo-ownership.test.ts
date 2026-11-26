import { describe, expect, it } from 'vitest';
import { finishSchema } from '../finish';
import { projectSchema } from '../project';
import { stoneSchema } from '../stone';

// Una foto debe vivir bajo `<carpeta>/<id de ESA entidad>/`: evita que un registro referencie
// fotos de otra entidad (o inexistentes) por id.
const stone = {
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
  descripcion: 'Ejemplo.',
  existencia: 'En patio',
  entregaDias: 7,
  vendidaPor: ['m2'],
  pesoKgPorPieza: null,
  densidadKgM3: 2200,
  fotos: [],
  proyectosRelacionados: [],
  activa: true,
};
const project = {
  id: 'casa-tepeyahualco',
  titulo: 'Casa',
  categoria: 'fachadas',
  ubicacion: 'Puebla',
  anio: 2024,
  descripcion: 'Ejemplo.',
  superficie: '120 m2',
  piedras: [],
  acabados: [],
  piezasLabradas: null,
  entrega: '2 semanas',
  testimonio: null,
  fotos: [],
  estado: 'borrador',
  activa: true,
};
const finish = { id: 'apomazado', nombre: 'A', descripcion: '', foto: null, activa: true };

const UUID = '3f2b8c1e-9a4d-4e6b-8c7a-1d2e3f4a5b6c';

describe('las fotos pertenecen a su entidad', () => {
  it('piedra: foto propia sí; de otra piedra o carpeta con otro id no', () => {
    expect(
      stoneSchema.safeParse({ ...stone, fotos: [`stones/arenisca/${UUID}.jpg`] }).success,
    ).toBe(true);
    const ajena = stoneSchema.safeParse({ ...stone, fotos: [`stones/caliza/${UUID}.jpg`] });
    expect(ajena.success).toBe(false);
    expect(JSON.stringify(ajena.error?.issues)).not.toContain('caliza');
    expect(
      stoneSchema.safeParse({ ...stone, fotos: [`stones/arenisca-2/${UUID}.jpg`] }).success,
    ).toBe(false);
  });

  it('piedra: una sola foto ajena entre varias propias la invalida, con la ruta del elemento', () => {
    const r = stoneSchema.safeParse({
      ...stone,
      fotos: [`stones/arenisca/${UUID}.jpg`, `stones/otra/${UUID}.png`],
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.path.join('.') === 'fotos.1')).toBe(true);
  });

  it('proyecto: foto propia sí; ajena no', () => {
    expect(
      projectSchema.safeParse({ ...project, fotos: [`projects/casa-tepeyahualco/${UUID}.webp`] })
        .success,
    ).toBe(true);
    const ajena = projectSchema.safeParse({ ...project, fotos: [`projects/otro/${UUID}.webp`] });
    expect(ajena.success).toBe(false);
    expect(JSON.stringify(ajena.error?.issues)).not.toContain('otro/');
  });

  it('acabado: foto propia sí; null sí; ajena no', () => {
    expect(
      finishSchema.safeParse({ ...finish, foto: `finishes/apomazado/${UUID}.avif` }).success,
    ).toBe(true);
    expect(finishSchema.safeParse({ ...finish, foto: null }).success).toBe(true);
    const ajena = finishSchema.safeParse({ ...finish, foto: `finishes/cincelado/${UUID}.avif` });
    expect(ajena.success).toBe(false);
    expect(JSON.stringify(ajena.error?.issues)).not.toContain('cincelado');
  });
});
