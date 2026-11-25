import type { ImageFormat, ImageInfo, ImageProcessor } from '../processor';

// Cabeceras mínimas con los magic bytes reales de cada formato (no son imágenes decodificables).
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const pad = (head: number[], total = 64): Uint8Array => {
  const out = new Uint8Array(Math.max(total, head.length));
  out.set(head);
  return out;
};

export const MAGIC = {
  jpeg: pad([0xff, 0xd8, 0xff, 0xe0]),
  png: pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  webp: pad([...ascii('RIFF'), 0x24, 0, 0, 0, ...ascii('WEBP'), ...ascii('VP8 ')]),
  avif: pad([0, 0, 0, 0x1c, ...ascii('ftyp'), ...ascii('avif'), 0, 0, 0, 0, ...ascii('avifmif1')]),
  avifBrandInCompatibleList: pad([
    0,
    0,
    0,
    0x1c,
    ...ascii('ftyp'),
    ...ascii('mif1'),
    0,
    0,
    0,
    0,
    ...ascii('miafavif'),
  ]),
  gif: pad(ascii('GIF89a')),
  svg: pad(ascii('<svg xmlns="http://www.w3.org/2000/svg"></svg>')),
  html: pad(ascii('<!doctype html><script>alert(1)</script>')),
  heic: pad([0, 0, 0, 0x18, ...ascii('ftyp'), ...ascii('heic'), 0, 0, 0, 0]),
  riffNotWebp: pad([...ascii('RIFF'), 0x24, 0, 0, 0, ...ascii('WAVE')]),
} as const satisfies Record<string, Uint8Array>;

export class FakeProcessor implements ImageProcessor {
  public inspected = 0;
  public resized: number[] = [];

  public constructor(
    public info: ImageInfo = { format: 'jpeg', width: 3000, height: 2000 },
    private readonly failWith?: Error,
  ) {}

  public inspect(): Promise<ImageInfo> {
    this.inspected += 1;
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve(this.info);
  }

  public toWebp(_input: Uint8Array, width: number): Promise<Uint8Array> {
    this.resized.push(width);
    return Promise.resolve(new TextEncoder().encode(`webp:${width}`));
  }
}

export const info = (format: ImageFormat, width: number, height: number): ImageInfo => ({
  format,
  width,
  height,
});
