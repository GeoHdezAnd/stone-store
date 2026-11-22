import { describe, expect, it } from 'vitest';
import {
  emailRateKey,
  ipRateKey,
  MAX_QUOTES_PER_EMAIL_PER_DAY,
  MAX_QUOTES_PER_IP_PER_DAY,
  normalizeEmailForRate,
  RATE_LIMIT_TTL_SECONDS,
  rateLimitDay,
  rateLimitExpiresAt,
  secondsUntilNextRateLimitDay,
} from '../rate-limit';

const HASH = 'a'.repeat(64);
const NOW = new Date('2026-11-20T15:30:00.000Z');

describe('topes del límite de envíos', () => {
  it('5 solicitudes por día por correo y 20 por IP', () => {
    expect(MAX_QUOTES_PER_EMAIL_PER_DAY).toBe(5);
    expect(MAX_QUOTES_PER_IP_PER_DAY).toBe(20);
  });

  it('el atributo ttl dura 2 días', () => {
    expect(RATE_LIMIT_TTL_SECONDS).toBe(2 * 24 * 60 * 60);
  });
});

describe('rateLimitDay', () => {
  it('es la fecha UTC AAAA-MM-DD', () => {
    expect(rateLimitDay(NOW)).toBe('2026-11-20');
    // 18:30 del 20 en CDMX ya es el 21 en UTC: el cupo sigue a UTC.
    expect(rateLimitDay(new Date('2026-11-21T00:30:00.000Z'))).toBe('2026-11-21');
    expect(rateLimitDay(new Date('2026-12-31T23:59:59.999Z'))).toBe('2026-12-31');
  });
});

describe('claves de contador', () => {
  it('correo: rate#email#<hash>#<día>', () => {
    expect(emailRateKey(HASH, NOW)).toBe(`rate#email#${HASH}#2026-11-20`);
  });

  it('ip: rate#ip#<hash>#<día>', () => {
    expect(ipRateKey(HASH, NOW)).toBe(`rate#ip#${HASH}#2026-11-20`);
  });

  it.each([
    'cliente@example.com',
    '203.0.113.7',
    'A'.repeat(64),
    'a'.repeat(63),
    'a'.repeat(65),
    '',
  ])(
    'rechaza algo que no es un sha256 en hexadecimal minúscula (%s): nunca PII en una clave',
    (bad) => {
      expect(() => emailRateKey(bad, NOW)).toThrow(RangeError);
      expect(() => ipRateKey(bad, NOW)).toThrow(RangeError);
    },
  );

  it('las claves caen bajo `rate#*` y no bajo `folio#*`', () => {
    expect(emailRateKey(HASH, NOW).startsWith('rate#')).toBe(true);
    expect(ipRateKey(HASH, NOW).startsWith('rate#')).toBe(true);
  });
});

describe('rateLimitExpiresAt', () => {
  it('son segundos epoch: ahora + 2 días', () => {
    expect(rateLimitExpiresAt(NOW)).toBe(Math.floor(NOW.getTime() / 1000) + 172_800);
  });
});

describe('normalizeEmailForRate', () => {
  it('minúsculas y sin espacios', () => {
    expect(normalizeEmailForRate('  Ana.Perez@Example.COM ')).toBe('ana.perez@example.com');
  });

  it('quita la etiqueta +algo del usuario (a+1@x y a+2@x son el mismo buzón)', () => {
    expect(normalizeEmailForRate('ana+uno@example.com')).toBe('ana@example.com');
    expect(normalizeEmailForRate('ana+a+b@example.com')).toBe('ana@example.com');
  });

  it('no toca un correo sin etiqueta ni el dominio', () => {
    expect(normalizeEmailForRate('ana@sub.example.com')).toBe('ana@sub.example.com');
  });
});

describe('secondsUntilNextRateLimitDay', () => {
  it('segundos hasta las 00:00 UTC siguientes', () => {
    expect(secondsUntilNextRateLimitDay(NOW)).toBe(8.5 * 3600);
    expect(secondsUntilNextRateLimitDay(new Date('2026-11-20T00:00:00.000Z'))).toBe(86_400);
    expect(secondsUntilNextRateLimitDay(new Date('2026-11-20T23:59:59.000Z'))).toBe(1);
  });
});
