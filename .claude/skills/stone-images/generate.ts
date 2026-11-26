/**
 * Genera texturas ILUSTRATIVAS (no fotos) de las piedras del catálogo con SVG + sharp.
 * Es un respaldo visual para el proyecto académico: el negocio es ficticio.
 *
 * Uso (desde la raíz del repo):
 *   npx tsx .claude/skills/stone-images/generate.ts                 # todas las piedras
 *   npx tsx .claude/skills/stone-images/generate.ts arenisca laja   # solo algunas
 * Salida: .generated/stone-images/<id>/<id>-1.jpg (1600x1200). Determinista: misma entrada, misma imagen.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const WIDTH = 1600;
const HEIGHT = 1200;
const OUT_DIR = path.resolve(process.cwd(), '.generated/stone-images');

interface Look {
  /** Color de fondo. */
  base: string;
  /** Manchas grandes (dos tonos). */
  tints: [string, string];
  /** Frecuencia de las manchas `x y`; valores distintos estiran la veta. */
  freq: [number, number];
  /** Fuerza de las manchas (0 a 1). */
  blotch: number;
  /** Intensidad del grano fino (0 a 1). */
  grain: number;
  /** Poros oscuros (cantidad). */
  pores: number;
  /** Estratos horizontales (laja, travertino). */
  strata?: number;
  /** Dibuja guijarros en lugar de una placa. */
  pebbles?: boolean;
  /** `slabs`: losas irregulares con juntas (laja). `travertine`: huecos alargados y bandas suaves. */
  style?: 'slabs' | 'travertine';
  seed: number;
}

// Semillas y colores salen de `content/stones.json` (colores) y se afinan a ojo.
const LOOKS: Record<string, Look> = {
  arenisca: {
    base: '#d8b98a',
    tints: ['#c79d63', '#ead3a8'],
    freq: [0.006, 0.02],
    blotch: 0.55,
    grain: 0.35,
    pores: 60,
    seed: 11,
  },
  caliza: {
    base: '#e3dccb',
    tints: ['#c9c2b1', '#f1ecde'],
    freq: [0.01, 0.012],
    blotch: 0.4,
    grain: 0.3,
    pores: 40,
    seed: 23,
  },
  'recinto-negro': {
    base: '#26252a',
    tints: ['#0e0e11', '#4a484f'],
    freq: [0.015, 0.015],
    blotch: 0.5,
    grain: 0.5,
    pores: 260,
    seed: 37,
  },
  'cantera-rosa': {
    base: '#d9a08f',
    tints: ['#c27f6e', '#ecbfae'],
    freq: [0.008, 0.01],
    blotch: 0.5,
    grain: 0.4,
    pores: 140,
    seed: 41,
  },
  'cantera-blanca': {
    base: '#f0ebdd',
    tints: ['#dcd5c3', '#fbf8ef'],
    freq: [0.008, 0.01],
    blotch: 0.3,
    grain: 0.3,
    pores: 90,
    seed: 53,
  },
  laja: {
    base: '#8a8a7c',
    tints: ['#6f7461', '#b49a6a'],
    freq: [0.012, 0.014],
    blotch: 0.6,
    grain: 0.4,
    pores: 30,
    style: 'slabs',
    seed: 67,
  },
  travertino: {
    base: '#dcc79b',
    tints: ['#c9ae78', '#efe0bd'],
    freq: [0.007, 0.016],
    blotch: 0.45,
    grain: 0.25,
    pores: 0,
    style: 'travertine',
    seed: 79,
  },
  'piedra-bola': {
    base: '#6d655b',
    tints: ['#4a443d', '#8f8678'],
    freq: [0.02, 0.02],
    blotch: 0.4,
    grain: 0.4,
    pores: 0,
    pebbles: true,
    seed: 83,
  },
};

/** Generador pseudoaleatorio con semilla (mulberry32): garantiza imágenes reproducibles. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Capa de manchas: el ruido controla la opacidad del color. */
function blotchLayer(
  id: string,
  color: string,
  fx: number,
  fy: number,
  seed: number,
  strength: number,
): string {
  const [r, g, b] = hexToRgb(color).map((v) => v / 255);
  return `
    <filter id="${id}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="${fx} ${fy}" numOctaves="5" seed="${seed}"/>
      <feColorMatrix type="matrix" values="0 0 0 0 ${r}  0 0 0 0 ${g}  0 0 0 0 ${b}  ${(strength * 3.2).toFixed(2)} 0 0 0 ${(-strength * 1.1).toFixed(2)}"/>
    </filter>
    <rect width="${WIDTH}" height="${HEIGHT}" filter="url(#${id})"/>`;
}

function pebbleShapes(look: Look): string {
  const rand = rng(look.seed);
  const [dark, light] = look.tints;
  const out: string[] = [];
  const cols = 14;
  const rows = 11;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cx =
        (col + 0.5) * (WIDTH / cols) + (row % 2 ? WIDTH / cols / 2 : 0) + (rand() - 0.5) * 36;
      const cy = (row + 0.5) * (HEIGHT / rows) + (rand() - 0.5) * 36;
      const rx = 52 + rand() * 24;
      const ry = rx * (0.82 + rand() * 0.18);
      const tone = rand();
      const fill = tone < 0.35 ? dark : tone < 0.75 ? look.base : light;
      const rot = Math.round(rand() * 180);
      const at = `rotate(${rot} ${cx.toFixed(0)} ${cy.toFixed(0)})`;
      // Sombra, cuerpo y un solo brillo tenue: da volumen sin parecer caricatura.
      out.push(
        `<ellipse cx="${(cx + 6).toFixed(0)}" cy="${(cy + 8).toFixed(0)}" rx="${rx.toFixed(0)}" ry="${ry.toFixed(0)}" transform="${at}" fill="#000" opacity="0.35" filter="url(#soft)"/>`,
        `<ellipse cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" rx="${rx.toFixed(0)}" ry="${ry.toFixed(0)}" transform="${at}" fill="${fill}" filter="url(#soft)"/>`,
        `<ellipse cx="${(cx - rx * 0.3).toFixed(0)}" cy="${(cy - ry * 0.35).toFixed(0)}" rx="${(rx * 0.35).toFixed(0)}" ry="${(ry * 0.22).toFixed(0)}" transform="${at}" fill="#fff" opacity="0.07" filter="url(#soft)"/>`,
      );
    }
  }
  return `<filter id="soft"><feGaussianBlur stdDeviation="2.5"/></filter>${out.join('')}`;
}

/** Losas irregulares: cuadriláteros con vértices desplazados y juntas oscuras entre ellas. */
function slabShapes(look: Look): string {
  const rand = rng(look.seed + 3000);
  const cols = 6;
  const rows = 5;
  const cw = WIDTH / cols;
  const ch = HEIGHT / rows;
  // Vértices compartidos con desplazamiento: las losas encajan sin huecos entre ellas.
  const pts: [number, number][][] = [];
  for (let r = 0; r <= rows; r++) {
    pts.push([]);
    for (let c = 0; c <= cols; c++) {
      const jx = c === 0 || c === cols ? 0 : (rand() - 0.5) * cw * 0.35;
      const jy = r === 0 || r === rows ? 0 : (rand() - 0.5) * ch * 0.35;
      pts[r]!.push([c * cw + jx, r * ch + jy]);
    }
  }
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const quad = [pts[r]![c]!, pts[r]![c + 1]!, pts[r + 1]![c + 1]!, pts[r + 1]![c]!]
        .map(([x, y]) => `${x.toFixed(0)},${y.toFixed(0)}`)
        .join(' ');
      const fill = look.tints[rand() < 0.5 ? 0 : 1];
      out.push(
        `<polygon points="${quad}" fill="${fill}" opacity="${(0.12 + rand() * 0.3).toFixed(2)}"/>`,
        `<polygon points="${quad}" fill="none" stroke="#17170f" stroke-width="${(4 + rand() * 4).toFixed(1)}" stroke-linejoin="round" opacity="0.75"/>`,
      );
    }
  }
  return out.join('');
}

/** Travertino: huecos alargados (su rasgo real) y bandas anchas y suaves, sin líneas rectas. */
function travertineShapes(look: Look): string {
  const rand = rng(look.seed + 4000);
  const out: string[] = [
    '<filter id="blur-band"><feGaussianBlur stdDeviation="14"/></filter>',
    '<filter id="blur-hole"><feGaussianBlur stdDeviation="1.4"/></filter>',
  ];
  for (let i = 0; i < 9; i++) {
    const y = rand() * HEIGHT;
    const h = 30 + rand() * 70;
    const tone = look.tints[i % 2]!;
    out.push(
      `<rect x="-40" y="${y.toFixed(0)}" width="${WIDTH + 80}" height="${h.toFixed(0)}" fill="${tone}" opacity="${(0.18 + rand() * 0.2).toFixed(2)}" filter="url(#blur-band)"/>`,
    );
  }
  for (let i = 0; i < 90; i++) {
    const cx = rand() * WIDTH;
    const cy = rand() * HEIGHT;
    const rx = 18 + rand() * 80;
    const ry = 3 + rand() * 7;
    out.push(
      // Hueco oscuro y un reborde claro debajo, como una cavidad real.
      `<ellipse cx="${cx.toFixed(0)}" cy="${(cy + 2).toFixed(0)}" rx="${rx.toFixed(0)}" ry="${ry.toFixed(1)}" fill="#fff" opacity="0.22" filter="url(#blur-hole)"/>`,
      `<ellipse cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" rx="${rx.toFixed(0)}" ry="${ry.toFixed(1)}" fill="#5a4a2c" opacity="${(0.3 + rand() * 0.3).toFixed(2)}" filter="url(#blur-hole)"/>`,
    );
  }
  return out.join('');
}

function poreDots(look: Look): string {
  if (look.pores === 0) return '';
  const rand = rng(look.seed + 1000);
  const dots: string[] = [];
  for (let i = 0; i < look.pores; i++) {
    const r = 1.2 + rand() * (look.pebbles ? 2 : 4.5);
    dots.push(
      `<ellipse cx="${(rand() * WIDTH).toFixed(0)}" cy="${(rand() * HEIGHT).toFixed(0)}" rx="${r.toFixed(1)}" ry="${(r * (0.5 + rand() * 0.6)).toFixed(1)}" fill="#000" opacity="${(0.12 + rand() * 0.25).toFixed(2)}"/>`,
    );
  }
  return dots.join('');
}

function strataLines(look: Look): string {
  if (!look.strata) return '';
  const rand = rng(look.seed + 2000);
  const lines: string[] = [];
  for (let i = 1; i <= look.strata; i++) {
    const y = (HEIGHT / (look.strata + 1)) * i + (rand() - 0.5) * 30;
    const wobble = (rand() - 0.5) * 24;
    lines.push(
      `<path d="M0 ${y.toFixed(0)} Q ${WIDTH / 2} ${(y + wobble).toFixed(0)} ${WIDTH} ${(y + wobble / 2).toFixed(0)}" stroke="#000" stroke-width="${(1 + rand() * 2.5).toFixed(1)}" fill="none" opacity="${(0.08 + rand() * 0.14).toFixed(2)}"/>`,
    );
  }
  return lines.join('');
}

function buildSvg(look: Look): string {
  const [tintA, tintB] = look.tints;
  const [fx, fy] = look.freq;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <rect width="${WIDTH}" height="${HEIGHT}" fill="${look.base}"/>
    ${blotchLayer('a', tintA, fx, fy, look.seed, look.blotch)}
    ${blotchLayer('b', tintB, fx * 1.7, fy * 1.7, look.seed + 5, look.blotch * 0.8)}
    ${look.pebbles ? pebbleShapes(look) : ''}
    ${look.style === 'slabs' ? slabShapes(look) : ''}
    ${look.style === 'travertine' ? travertineShapes(look) : ''}
    ${strataLines(look)}
    ${poreDots(look)}
    <filter id="grain" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="${look.seed + 9}"/>
      <feColorMatrix type="matrix" values="0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 ${look.grain.toFixed(2)} 0"/>
    </filter>
    <rect width="${WIDTH}" height="${HEIGHT}" filter="url(#grain)" opacity="0.55"/>
    <radialGradient id="vignette" cx="50%" cy="50%" r="75%">
      <stop offset="60%" stop-color="#000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.18"/>
    </radialGradient>
    <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#vignette)"/>
  </svg>`;
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2);
  const ids = requested.length > 0 ? requested : Object.keys(LOOKS);
  const unknown = ids.filter((id) => !(id in LOOKS));
  if (unknown.length > 0) {
    throw new Error(
      `Piedras sin receta: ${unknown.join(', ')}. Disponibles: ${Object.keys(LOOKS).join(', ')}`,
    );
  }
  for (const id of ids) {
    const dir = path.join(OUT_DIR, id);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${id}-1.jpg`);
    const svg = buildSvg(LOOKS[id]!);
    await writeFile(
      file,
      await sharp(Buffer.from(svg)).jpeg({ quality: 88, mozjpeg: true }).toBuffer(),
    );
    console.info(`✔ ${path.relative(process.cwd(), file)}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
