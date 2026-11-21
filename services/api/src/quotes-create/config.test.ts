import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const BASE = {
  QUOTES_TABLE: 'Quotes',
  COUNTERS_TABLE: 'Counters',
  STONES_TABLE: 'Stones',
  FREIGHT_CONFIG_TABLE: 'FreightConfig',
  SETTINGS_TABLE: 'Settings',
};

describe('loadConfig de quotes-create', () => {
  it('lee las 5 tablas obligatorias y deja lo opcional sin definir', () => {
    expect(loadConfig(BASE)).toEqual({
      quotes: 'Quotes',
      counters: 'Counters',
      stones: 'Stones',
      freightConfig: 'FreightConfig',
      settings: 'Settings',
    });
  });

  it.each(Object.keys(BASE))('falla con un mensaje claro si falta %s', (faltante) => {
    expect(() => loadConfig({ ...BASE, [faltante]: undefined })).toThrow(new RegExp(faltante));
    expect(() => loadConfig({ ...BASE, [faltante]: '' })).toThrow(new RegExp(faltante));
  });

  describe('ADMIN_BASE_URL', () => {
    it('acepta https y la normaliza a su origen (sin barra final)', () => {
      expect(
        loadConfig({ ...BASE, ADMIN_BASE_URL: 'https://admin.ejemplo.mx/' }).adminBaseUrl,
      ).toBe('https://admin.ejemplo.mx');
    });

    it.each(['http://localhost:5173', 'http://127.0.0.1:5173'])(
      'acepta %s (solo localhost con http)',
      (u) => {
        expect(loadConfig({ ...BASE, ADMIN_BASE_URL: u }).adminBaseUrl).toBe(u);
      },
    );

    it('vacía = sin enlace', () => {
      expect(loadConfig({ ...BASE, ADMIN_BASE_URL: '' }).adminBaseUrl).toBeUndefined();
    });

    it.each([
      'http://admin.ejemplo.mx',
      'javascript:alert(1)',
      'ftp://admin.ejemplo.mx',
      'admin.ejemplo.mx',
      'https://admin.ejemplo.mx/ruta',
      'https://a@admin.ejemplo.mx',
      'https://admin.ejemplo.mx?x=1',
      'https://admin"onmouseover=x.mx',
    ])('rechaza %s', (u) => {
      expect(() => loadConfig({ ...BASE, ADMIN_BASE_URL: u })).toThrow(/ADMIN_BASE_URL/);
    });
  });

  describe('Turnstile', () => {
    it('TURNSTILE_MODE=fake se reconoce', () => {
      expect(loadConfig({ ...BASE, TURNSTILE_MODE: 'fake' }).turnstileMode).toBe('fake');
    });

    it.each(['FAKE', 'real', 'off', 'true', ' fake'])(
      'rechaza TURNSTILE_MODE=%s (falla cerrado)',
      (m) => {
        expect(() => loadConfig({ ...BASE, TURNSTILE_MODE: m })).toThrow(/TURNSTILE_MODE/);
      },
    );

    it('TURNSTILE_MODE vacío = sin modo', () => {
      expect(loadConfig({ ...BASE, TURNSTILE_MODE: '' }).turnstileMode).toBeUndefined();
    });

    it('acepta un nombre jerárquico de parámetro SSM', () => {
      expect(
        loadConfig({ ...BASE, TURNSTILE_SECRET_PARAM: '/canteras/dev/turnstile-secret' })
          .turnstileSecretParam,
      ).toBe('/canteras/dev/turnstile-secret');
    });

    it.each([
      'sin-barra',
      '/con espacio',
      '/a//b',
      '/termina/',
      '/*',
      '/a/*',
      '/ñ',
      '/' + 'a'.repeat(1011),
    ])('rechaza el nombre de parámetro %s', (n) => {
      expect(() => loadConfig({ ...BASE, TURNSTILE_SECRET_PARAM: n })).toThrow(
        /TURNSTILE_SECRET_PARAM/,
      );
    });

    it('el modo fake y el parámetro real a la vez son ambiguos: error', () => {
      expect(() =>
        loadConfig({ ...BASE, TURNSTILE_MODE: 'fake', TURNSTILE_SECRET_PARAM: '/x/y' }),
      ).toThrow(/TURNSTILE/);
    });
  });
});
