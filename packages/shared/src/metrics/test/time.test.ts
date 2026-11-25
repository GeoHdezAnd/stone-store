import { describe, expect, it } from 'vitest';
import {
  addLocalDays,
  localDateString,
  localStartOfDay,
  localStartOfMonth,
  localStartOfWeek,
  MEXICO_CITY_TIMEZONE,
  MEXICO_CITY_UTC_OFFSET_HOURS,
} from '../time';

const ms = (iso: string): number => Date.parse(iso);

describe('huso horario de Ciudad de México', () => {
  it('usa UTC-6 fijo (sin horario de verano desde 2022)', () => {
    expect(MEXICO_CITY_TIMEZONE).toBe('America/Mexico_City');
    expect(MEXICO_CITY_UTC_OFFSET_HOURS).toBe(-6);
  });

  describe('localStartOfDay', () => {
    it('un milisegundo antes de la medianoche local pertenece al día anterior', () => {
      expect(new Date(localStartOfDay(ms('2026-11-24T05:59:59.999Z'))).toISOString()).toBe(
        '2026-11-23T06:00:00.000Z',
      );
    });
    it('la medianoche local (06:00Z) abre el día nuevo', () => {
      expect(new Date(localStartOfDay(ms('2026-11-24T06:00:00.000Z'))).toISOString()).toBe(
        '2026-11-24T06:00:00.000Z',
      );
    });
  });

  describe('localStartOfMonth', () => {
    it('la madrugada UTC del día 1 todavía es el mes anterior', () => {
      expect(new Date(localStartOfMonth(ms('2026-12-01T05:59:59.999Z'))).toISOString()).toBe(
        '2026-11-01T06:00:00.000Z',
      );
    });
    it('a las 06:00Z del día 1 empieza el mes', () => {
      expect(new Date(localStartOfMonth(ms('2026-12-01T06:00:00.000Z'))).toISOString()).toBe(
        '2026-12-01T06:00:00.000Z',
      );
    });
    it('cruza el año: 1 de enero a las 05:59Z sigue siendo diciembre', () => {
      expect(new Date(localStartOfMonth(ms('2027-01-01T05:59:59.999Z'))).toISOString()).toBe(
        '2026-12-01T06:00:00.000Z',
      );
    });
  });

  describe('localStartOfWeek (lunes)', () => {
    it('un martes regresa al lunes de esa semana', () => {
      expect(new Date(localStartOfWeek(ms('2026-11-24T18:00:00.000Z'))).toISOString()).toBe(
        '2026-11-23T06:00:00.000Z',
      );
    });
    it('el domingo por la noche local sigue en la misma semana', () => {
      // Domingo 29 nov 23:00 local = lunes 30 nov 05:00Z.
      expect(new Date(localStartOfWeek(ms('2026-11-30T05:00:00.000Z'))).toISOString()).toBe(
        '2026-11-23T06:00:00.000Z',
      );
    });
    it('el lunes a las 00:00 local abre la semana nueva', () => {
      expect(new Date(localStartOfWeek(ms('2026-11-30T06:00:00.000Z'))).toISOString()).toBe(
        '2026-11-30T06:00:00.000Z',
      );
    });
    it('un milisegundo antes del lunes local pertenece a la semana anterior', () => {
      expect(new Date(localStartOfWeek(ms('2026-11-30T05:59:59.999Z'))).toISOString()).toBe(
        '2026-11-23T06:00:00.000Z',
      );
    });
  });

  describe('addLocalDays y localDateString', () => {
    it('suma y resta días completos desde el inicio de un día local', () => {
      const start = ms('2026-11-23T06:00:00.000Z');
      expect(new Date(addLocalDays(start, 7)).toISOString()).toBe('2026-11-30T06:00:00.000Z');
      expect(new Date(addLocalDays(start, -49)).toISOString()).toBe('2026-10-05T06:00:00.000Z');
    });
    it('da la fecha local YYYY-MM-DD', () => {
      expect(localDateString(ms('2026-11-24T05:59:59.999Z'))).toBe('2026-11-23');
      expect(localDateString(ms('2026-11-24T06:00:00.000Z'))).toBe('2026-11-24');
    });
  });
});
