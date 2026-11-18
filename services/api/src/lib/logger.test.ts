import { describe, expect, it } from 'vitest';
import { createLogger } from './logger';

function setup(base = {}) {
  const lines: string[] = [];
  const log = createLogger({ requestId: 'r-1', ...base }, (l) => lines.push(l));
  return { log, lines, last: () => JSON.parse(lines[lines.length - 1] as string) };
}

describe('logger', () => {
  it('emite una línea JSON por evento con nivel, msg y requestId', () => {
    const { log, lines, last } = setup();
    log.info('hola', { a: 1 });
    log.warn('cuidado');
    log.error('mal');
    expect(lines).toHaveLength(3);
    expect(last()).toEqual({ level: 'error', msg: 'mal', requestId: 'r-1' });
    expect(JSON.parse(lines[0] as string)).toEqual({
      level: 'info',
      msg: 'hola',
      requestId: 'r-1',
      a: 1,
    });
  });

  it.each([
    'correo',
    'email',
    'telefono',
    'phone',
    'whatsapp',
    'password',
    'contrasena',
    'authorization',
    'token',
    'accessToken',
    'idToken',
    'refreshToken',
    'secret',
    'cookie',
    'EMAIL',
    'Authorization',
  ])('redacta la clave %s', (key) => {
    const { log, last } = setup();
    log.info('x', { [key]: 'valor-sensible', ok: 'visible' });
    expect(last()[key]).toBe('[redacted]');
    expect(last().ok).toBe('visible');
  });

  it('redacta en profundidad, también dentro de arreglos', () => {
    const { log, last } = setup();
    log.info('x', { a: { b: [{ Correo: 'x', n: 1 }] } });
    expect(last().a.b[0]).toEqual({ Correo: '[redacted]', n: 1 });
  });

  it('enmascara correos y secuencias de 10+ dígitos en cadenas', () => {
    const { log, last } = setup();
    log.info('cliente juan@example.com tel 5512345678 folio 12345', {
      nota: 'a@b.mx y 2222222222222',
    });
    const out = last();
    expect(out.msg).not.toContain('juan@example.com');
    expect(out.msg).not.toContain('5512345678');
    expect(out.msg).toContain('12345');
    expect(out.nota).not.toMatch(/@|\d{10}/);
  });

  it('no lanza con referencias circulares', () => {
    const { log, lines } = setup();
    const a: Record<string, unknown> = { n: 1 };
    a.self = a;
    expect(() => log.info('x', { a })).not.toThrow();
    expect(lines).toHaveLength(1);
  });

  it('no lanza con profundidad excesiva', () => {
    const { log, lines } = setup();
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 500; i++) deep = { n: deep };
    expect(() => log.info('x', { deep })).not.toThrow();
    expect(lines).toHaveLength(1);
  });

  it('serializa Error sin stack y sin lanzar con bigint', () => {
    const { log, last } = setup();
    log.error('fallo', { err: new Error('boom'), big: 10n });
    expect(last().err.message).toBe('boom');
    expect(last().err.stack).toBeUndefined();
  });

  it('los campos del usuario no pueden pisar level ni msg', () => {
    const { log, last } = setup();
    log.info('real', { level: 'fake', msg: 'fake' });
    expect(last().level).toBe('info');
    expect(last().msg).toBe('real');
  });

  it.each([
    'access_token',
    'id_token',
    'x-api-key',
    'set-cookie',
    'Set-Cookie',
    'nombre',
    'nombreCliente',
    'clientSecret',
    'userPassword',
    'customer',
    'x-auth',
    'API_KEY',
    'telefonoCliente',
    'correo_electronico',
  ])('redacta por subcadena la clave normalizada %s', (key) => {
    const { log, last } = setup();
    log.info('x', { [key]: 'valor' });
    expect(last()[key]).toBe('[redacted]');
  });

  it('codigoPostal se deja en claro (no identifica a una persona por sí solo)', () => {
    const { log, last } = setup();
    log.info('x', { codigoPostal: '74000' });
    expect(last().codigoPostal).toBe('74000');
  });

  it.each([
    'tel 222 987 6543 ok',
    'tel +52 (222) 123-45-67 ok',
    'tel 222.123.4567',
    'tel 2221234567',
  ])('enmascara teléfonos con separadores: %s', (msg) => {
    const { log, last } = setup();
    log.info(msg);
    expect(last().msg).toContain('[digits]');
    expect(last().msg).not.toMatch(/123/);
  });

  it('documenta: el correo ofuscado juan[at]x.com NO se enmascara', () => {
    const { log, last } = setup();
    log.info('juan[at]x.com');
    expect(last().msg).toBe('juan[at]x.com');
  });

  it('no enmascara números cortos como folios', () => {
    const { log, last } = setup();
    log.info('folio CN-2026-00042 cp 74000');
    expect(last().msg).toBe('folio CN-2026-00042 cp 74000');
  });

  it('trunca cadenas largas antes de enmascarar', () => {
    const { log, last } = setup();
    log.info('x', { s: 'a'.repeat(5000) });
    expect(last().s.length).toBeLessThan(2100);
    expect(last().s.endsWith('…[truncated]')).toBe(true);
  });

  it.each([
    ['sin @', 'a'.repeat(262_144)],
    ['dígitos y separadores', '1 '.repeat(130_000)],
    ['arrobas repetidas', 'a@'.repeat(130_000)],
    ['correo sin cierre', `${'a'.repeat(100)}@${'b'.repeat(200_000)}`],
  ])('procesa entradas hostiles (%s) en <50 ms', (_n, input) => {
    const { log } = setup();
    const t = performance.now();
    log.info(input, { s: input });
    expect(performance.now() - t).toBeLessThan(50);
  });

  it('serializa Error.cause sanitizado', () => {
    const { log, last } = setup();
    log.error('x', { err: new Error('a', { cause: new Error('causa juan@example.com') }) });
    expect(last().err.cause.message).toContain('[email]');
    expect(JSON.stringify(last())).not.toContain('juan@example.com');
  });

  it('una línea que excede 16 KB sale truncada pero como JSON válido', () => {
    const { log, lines } = setup();
    const many: Record<string, string> = {};
    for (let i = 0; i < 100; i++) many[`k${i}`] = 'z'.repeat(1500);
    log.info('grande', many);
    expect(lines[0]?.length).toBeLessThanOrEqual(16 * 1024);
    const parsed = JSON.parse(lines[0] as string);
    expect(parsed).toMatchObject({
      level: 'info',
      msg: 'grande',
      requestId: 'r-1',
      truncated: true,
    });
  });

  it('una clave __proto__ propia se conserva y no cambia el prototipo', () => {
    const { log, last } = setup();
    const payload = JSON.parse('{"__proto__": {"admin": true}, "ok": 1}');
    log.info('x', payload);
    expect(Object.getPrototypeOf(last())).toBe(Object.prototype);
    expect(last().admin).toBeUndefined();
    expect(Object.keys(last())).toContain('__proto__');
  });
  it.each(['url', 'signedUrl', 'presignedUrl', 'signature', 'x-amz-signature', 'X-Amz-Credential'])(
    'redacta la clave %s (URLs prefirmadas y firmas son secretos de corta vida)',
    (key) => {
      const { log, last } = setup();
      log.info('x', { [key]: 'https://b.s3.amazonaws.com/k?X-Amz-Signature=abc123' });
      expect(last()[key]).toBe('[redacted]');
    },
  );

  it('enmascara parámetros de firma de S3 aunque vayan dentro de un texto libre', () => {
    const { log, lines } = setup();
    log.warn(
      'fallo al subir https://b.s3.amazonaws.com/k?X-Amz-Credential=AKIAX%2F2026&X-Amz-Signature=deadbeef&X-Amz-Security-Token=tok123 fin',
    );
    expect(lines[0]).not.toContain('deadbeef');
    expect(lines[0]).not.toContain('AKIAX');
    expect(lines[0]).not.toContain('tok123');
  });
  it('no enmascara como teléfono los dígitos de un UUID (claves de S3), pero sí un teléfono pegado', () => {
    const { log, last } = setup();
    const key = 'stones/cantera-rosa/12345678-1234-4234-8234-123456789012.png';
    log.info('x', { key, texto: `llama al 222 987 6543 para ${key}` });
    expect(last().key).toBe(key);
    expect(last().texto).toContain('[digits]');
    expect(last().texto).not.toContain('6543');
    expect(last().texto).toContain(key);
  });
  describe('URL prefirmada codificada', () => {
    const URL_REAL =
      'https://b.s3.us-east-1.amazonaws.com/stones/a/x.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAXXXX%2F20261118%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261118T223352Z&X-Amz-Expires=300&X-Amz-Security-Token=TOKENSECRETO123&X-Amz-Signature=FIRMASECRETA456&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost';
    const variantes: [string, string][] = [
      ['cruda', URL_REAL],
      ['codificada una vez', encodeURIComponent(URL_REAL)],
      ['codificada dos veces', encodeURIComponent(encodeURIComponent(URL_REAL))],
      ['en minúsculas', URL_REAL.toLowerCase()],
    ];
    it.each(variantes)('%s: no se filtra en un campo de nombre arbitrario', (_n, valor) => {
      const { log, lines } = setup();
      log.info('x', { detalle: valor });
      const t = lines[0] as string;
      for (const secreto of ['FIRMASECRETA456', 'TOKENSECRETO123', 'AKIAXXXX']) {
        expect(t.toLowerCase(), secreto).not.toContain(secreto.toLowerCase());
      }
    });
    it.each(variantes)('%s: no se filtra dentro de un mensaje de error', (_n, valor) => {
      const { log, lines } = setup();
      log.error('fallo', { err: new Error(`PUT falló en ${valor} reintento`) });
      const t = lines[0] as string;
      expect(t.toLowerCase()).not.toContain('firmasecreta456');
      expect(t.toLowerCase()).not.toContain('tokensecreto123');
    });
    it('el valor termina en & o %26: lo que sigue no se borra', () => {
      const { log, lines } = setup();
      log.info('x', { d: 'a?X-Amz-Signature%3DABC%26otro=1 y X-Amz-Signature=DEF&resto=2' });
      const t = lines[0] as string;
      expect(t).toContain('otro=1');
      expect(t).toContain('resto=2');
      expect(t).not.toContain('ABC');
      expect(t).not.toContain('DEF');
    });
    it('256 KB hostiles se procesan en menos de 50 ms', () => {
      const { log } = setup();
      for (const hostil of [
        'X-Amz-Signature%3D'.repeat(14_000),
        'X-Amz-Signature='.repeat(16_000),
        '%3D%3D%3D%26'.repeat(22_000),
        'X-Amz-Credential'.repeat(16_000),
      ]) {
        const t0 = performance.now();
        log.info('x', { d: hostil.slice(0, 262_144) });
        expect(performance.now() - t0).toBeLessThan(50);
      }
    });
  });
});
