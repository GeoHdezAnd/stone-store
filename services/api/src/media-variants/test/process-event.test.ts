import { describe, expect, it } from 'vitest';
import { MAX_MEDIA_BYTES, variantKey } from '@canteras/shared';
import type { S3Event } from 'aws-lambda';
import { createLogger } from '../../lib/logger';
import { createVariantsHandler, decodeS3Key, type ObjectStore } from '../process-event';
import { ImageRejectedError } from '../processor';
import { FakeProcessor, MAGIC, info } from './fixtures';

const BUCKET = 'canteras-media-dev';
const UUID = '3f2b8c1e-9a4d-4e6b-8c7a-1d2e3f4a5b6c';
const ORIGINAL = `stones/arenisca/${UUID}.jpg`;

interface Put {
  bucket: string;
  key: string;
  body: Uint8Array;
  contentType: string;
  cacheControl: string;
}

class FakeStore implements ObjectStore {
  public gets: string[] = [];
  public puts: Put[] = [];
  public objects = new Map<string, Uint8Array>();
  public getError: Error | undefined;
  public putError: Error | undefined;

  public get(bucket: string, key: string): Promise<Uint8Array> {
    this.gets.push(`${bucket}/${key}`);
    if (this.getError) return Promise.reject(this.getError);
    const body = this.objects.get(key);
    return body ? Promise.resolve(body) : Promise.reject(new Error('NoSuchKey'));
  }

  public put(
    bucket: string,
    key: string,
    body: Uint8Array,
    meta: { contentType: string; cacheControl: string },
  ): Promise<void> {
    if (this.putError) return Promise.reject(this.putError);
    this.puts.push({ bucket, key, body, ...meta });
    return Promise.resolve();
  }
}

function event(
  ...records: Array<{ key: string; size?: number; bucket?: string; eventName?: string }>
): S3Event {
  return {
    Records: records.map((r) => ({
      eventName: r.eventName ?? 'ObjectCreated:Put',
      s3: { bucket: { name: r.bucket ?? BUCKET }, object: { key: r.key, size: r.size ?? 1000 } },
    })),
  } as unknown as S3Event;
}

function setup(opts: { info?: ReturnType<typeof info>; processorError?: Error } = {}) {
  const store = new FakeStore();
  const processor = new FakeProcessor(opts.info ?? info('jpeg', 3000, 2000), opts.processorError);
  const lines: string[] = [];
  const handler = createVariantsHandler({
    bucket: BUCKET,
    store,
    processor,
    logger: createLogger({}, (l) => lines.push(l)),
  });
  return { store, processor, lines, handler };
}

describe('decodeS3Key: la clave del evento viene URL-encoded', () => {
  it('decodifica + como espacio y %xx', () => {
    expect(decodeS3Key('stones/a+b/foto%2B1.jpg')).toBe('stones/a b/foto+1.jpg');
    expect(decodeS3Key('stones/a/%C3%A1.jpg')).toBe('stones/a/á.jpg');
  });

  it('una secuencia % inválida lanza ImageRejectedError(bad_key)', () => {
    expect(() => decodeS3Key('stones/a/%E0%A4%A.jpg')).toThrow(ImageRejectedError);
  });
});

describe('createVariantsHandler: camino feliz', () => {
  it('descarga el original y sube las 3 variantes con tipo y caché correctos', async () => {
    const { store, handler } = setup();
    store.objects.set(ORIGINAL, MAGIC.jpeg);
    await handler(event({ key: ORIGINAL }));
    expect(store.gets).toEqual([`${BUCKET}/${ORIGINAL}`]);
    expect(store.puts.map((p) => p.key)).toEqual([
      variantKey(ORIGINAL, 480),
      variantKey(ORIGINAL, 960),
      variantKey(ORIGINAL, 1600),
    ]);
    for (const p of store.puts) {
      expect(p.bucket).toBe(BUCKET);
      expect(p.contentType).toBe('image/webp');
      expect(p.cacheControl).toBe('public, max-age=31536000, immutable');
    }
  });

  it('procesa varios registros y decodifica la clave (%xx)', async () => {
    const { store, handler } = setup();
    const odd = `stones/a-b/foto-1.jpg`;
    store.objects.set(ORIGINAL, MAGIC.jpeg);
    store.objects.set(odd, MAGIC.jpeg);
    await handler(event({ key: ORIGINAL }, { key: 'stones/a%2Db/foto%2D1.jpg' }));
    expect(store.gets).toEqual([`${BUCKET}/${ORIGINAL}`, `${BUCKET}/${odd}`]);
    expect(store.puts).toHaveLength(6);
  });

  it('es idempotente: reprocesar escribe exactamente las mismas claves', async () => {
    const { store, handler } = setup();
    store.objects.set(ORIGINAL, MAGIC.jpeg);
    await handler(event({ key: ORIGINAL }));
    const first = store.puts.map((p) => p.key);
    store.puts = [];
    await handler(event({ key: ORIGINAL }));
    expect(store.puts.map((p) => p.key)).toEqual(first);
  });
});

describe('createVariantsHandler: anti-bucle y claves ajenas', () => {
  it('IGNORA las variantes (no descarga ni procesa)', async () => {
    const { store, processor, handler } = setup();
    await handler(event(...[480, 960, 1600].map((w) => ({ key: variantKey(ORIGINAL, w) }))));
    expect(store.gets).toEqual([]);
    expect(store.puts).toEqual([]);
    expect(processor.inspected).toBe(0);
  });

  it('IGNORA claves fuera de los prefijos permitidos o con formato raro', async () => {
    const { store, handler } = setup();
    await handler(
      event(
        { key: 'published/catalog.json' },
        { key: `otros/a/${UUID}.jpg` },
        { key: `stones/${UUID}.jpg` },
        { key: 'stones/a/%2E%2E/x.jpg' },
        { key: `stones/a/${UUID}.gif` },
      ),
    );
    expect(store.gets).toEqual([]);
    expect(store.puts).toEqual([]);
  });

  it('procesa también los prefijos projects/ y finishes/', async () => {
    const { store, handler } = setup();
    const p = `projects/casa/${UUID}.png`;
    const f = `finishes/labrado/${UUID}.webp`;
    store.objects.set(p, MAGIC.png);
    store.objects.set(f, MAGIC.webp);
    const s = setup({ info: info('png', 2000, 1000) });
    s.store.objects.set(p, MAGIC.png);
    await s.handler(event({ key: p }));
    expect(s.store.puts).toHaveLength(3);
    await handler(event({ key: f }));
    expect(store.gets).toEqual([`${BUCKET}/${f}`]);
  });

  it('IGNORA un bucket distinto del esperado', async () => {
    const { store, handler } = setup();
    store.objects.set(ORIGINAL, MAGIC.jpeg);
    await handler(event({ key: ORIGINAL, bucket: 'otro-bucket' }));
    expect(store.gets).toEqual([]);
  });

  it('IGNORA eventos que no son de creación de objeto', async () => {
    const { store, handler } = setup();
    store.objects.set(ORIGINAL, MAGIC.jpeg);
    await handler(event({ key: ORIGINAL, eventName: 'ObjectRemoved:Delete' }));
    expect(store.gets).toEqual([]);
  });

  it('un evento sin Records no falla', async () => {
    const { handler } = setup();
    await expect(handler({} as S3Event)).resolves.toBeUndefined();
  });
});

describe('createVariantsHandler: originales inválidos (sin bucle de reintentos)', () => {
  it('un tipo no permitido se registra y TERMINA sin lanzar ni subir nada', async () => {
    const { store, lines, handler } = setup();
    store.objects.set(ORIGINAL, MAGIC.svg);
    await expect(handler(event({ key: ORIGINAL }))).resolves.toBeUndefined();
    expect(store.puts).toEqual([]);
    const log = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(
      log.some((l) => l['msg'] === 'image_rejected' && l['reason'] === 'unsupported_type'),
    ).toBe(true);
  });

  it('un original corrupto no lanza', async () => {
    const { store, handler } = setup({ processorError: new ImageRejectedError('corrupt') });
    store.objects.set(ORIGINAL, MAGIC.jpeg);
    await expect(handler(event({ key: ORIGINAL }))).resolves.toBeUndefined();
    expect(store.puts).toEqual([]);
  });

  it('una foto borrada antes de procesarse (not_found) es benigna: warn, sin lanzar ni reintentar', async () => {
    const { store, lines, handler } = setup();
    store.getError = new ImageRejectedError('not_found');
    await expect(handler(event({ key: ORIGINAL }))).resolves.toBeUndefined();
    expect(lines.join('')).toContain('not_found');
    expect(
      lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .some((l) => l['level'] === 'error'),
    ).toBe(false);
  });

  it('un tamaño declarado en el evento sobre el tope se rechaza SIN descargar', async () => {
    const { store, lines, handler } = setup();
    store.objects.set(ORIGINAL, MAGIC.jpeg);
    await handler(event({ key: ORIGINAL, size: MAX_MEDIA_BYTES + 1 }));
    expect(store.gets).toEqual([]);
    expect(lines.join('')).toContain('too_large');
  });

  it('un objeto vacío (size 0) se rechaza sin descargar', async () => {
    const { store, handler } = setup();
    await handler(event({ key: ORIGINAL, size: 0 }));
    expect(store.gets).toEqual([]);
  });

  it('una clave con % inválido se registra y no detiene a los demás registros', async () => {
    const { store, handler } = setup();
    store.objects.set(ORIGINAL, MAGIC.jpeg);
    await handler(event({ key: 'stones/a/%E0%A4%A.jpg' }, { key: ORIGINAL }));
    expect(store.puts).toHaveLength(3);
  });

  it('los logs NO llevan la clave completa (solo una parte) ni el UUID completo de forma identificable por PII', async () => {
    const { store, lines, handler } = setup();
    store.objects.set(ORIGINAL, MAGIC.svg);
    await handler(event({ key: ORIGINAL }));
    const all = lines.join('\n');
    expect(all).not.toContain(ORIGINAL);
    expect(all).toContain('stones');
  });
});

describe('createVariantsHandler: fallos transitorios', () => {
  it('un fallo en un registro no impide procesar los demás, y al final lanza para reintentar', async () => {
    const { store, handler } = setup();
    const second = `stones/b/${UUID}.jpg`;
    store.objects.set(second, MAGIC.jpeg);
    // el primero no existe en el almacén: GetObject falla (transitorio)
    await expect(handler(event({ key: ORIGINAL }, { key: second }))).rejects.toThrow(
      'media_variants_failed',
    );
    expect(store.puts.map((p) => p.key)).toContain(variantKey(second, 480));
  });

  it('el error lanzado no filtra detalles internos', async () => {
    const { store, handler } = setup();
    store.getError = new Error('AccessDenied arn:aws:s3:::canteras-media-dev/secreto');
    store.objects.set(ORIGINAL, MAGIC.jpeg);
    await expect(handler(event({ key: ORIGINAL }))).rejects.toThrow(/^media_variants_failed$/);
  });

  it('el log de un fallo transitorio no lleva el mensaje del error (ARN, bucket, claves)', async () => {
    const { store, lines, handler } = setup();
    store.getError = new Error('AccessDenied arn:aws:s3:::canteras-media-dev/secreto');
    store.objects.set(ORIGINAL, MAGIC.jpeg);
    await expect(handler(event({ key: ORIGINAL }))).rejects.toThrow();
    const all = lines.join('\n');
    expect(all).toContain('variants_failed');
    expect(all).not.toContain('arn:aws');
    expect(all).not.toContain('secreto');
  });

  it('un fallo de PutObject también es transitorio', async () => {
    const { store, handler } = setup();
    store.objects.set(ORIGINAL, MAGIC.jpeg);
    store.putError = new Error('SlowDown');
    await expect(handler(event({ key: ORIGINAL }))).rejects.toThrow('media_variants_failed');
  });

  it('un rechazo permanente en un registro NO provoca el lanzamiento final', async () => {
    const { store, handler } = setup();
    const bad = `stones/b/${UUID}.jpg`;
    store.objects.set(bad, MAGIC.gif);
    store.objects.set(ORIGINAL, MAGIC.jpeg);
    await expect(handler(event({ key: bad }, { key: ORIGINAL }))).resolves.toBeUndefined();
  });
});
