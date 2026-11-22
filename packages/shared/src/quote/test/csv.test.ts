import { describe, expect, it } from 'vitest';
import { MAX_EXPORT_ROWS, neutralizeFormula, quotesToCsv } from '../csv';
import { sampleQuote } from './test-fixtures';

describe('neutralizeFormula', () => {
  it.each([
    '=1+1',
    '+1+1',
    "+cmd|' /C calc'!A0",
    '-1',
    '@SUM(A1)',
    '\t=x',
    '\r=x',
    '  =x',
    ' \t@x',
  ])('prefija %j', (v) => {
    expect(neutralizeFormula(v)).toBe(`'${v}`);
  });
  it.each([
    'hola',
    '',
    '1=1',
    'a@b.com',
    '555-0100',
    '+52 222 555 0100',
    '+1',
    ' +52 (222) 555-0100',
  ])('no toca %j', (v) => {
    expect(neutralizeFormula(v)).toBe(v);
  });
});

describe('teléfonos con lada', () => {
  it('«+52 222 555 0100» sale sin prefijo y un payload con + sale neutralizado', () => {
    const q = sampleQuote({
      customer: { nombre: 'A', telefono: '+52 222 555 0100', correo: 'a@example.com' },
      works: { lugar: "+cmd|' /C calc'!A0", codigoPostal: '74000', uso: '', notas: '' },
    });
    const csv = quotesToCsv([q]);
    expect(csv).toContain('"+52 222 555 0100"');
    expect(csv).not.toContain(`"'+52`);
    expect(csv).toContain(`"'+cmd|' /C calc'!A0"`);
  });
});

describe('quotesToCsv', () => {
  it('lleva BOM, CRLF, todo entre comillas y comillas duplicadas', () => {
    const q = sampleQuote({
      works: { lugar: 'Calle "Roble", 5', codigoPostal: '74000', uso: '', notas: '' },
    });
    const csv = quotesToCsv([q]);
    expect(csv.startsWith('﻿"Folio"')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines).toHaveLength(3); // encabezado + fila + cadena vacía final
    expect(lines[2]).toBe('');
    expect(lines[1]).toContain('"Calle ""Roble"", 5"');
    for (const cell of lines[1]!.match(/"(?:[^"]|"")*"/g)!) expect(cell.startsWith('"')).toBe(true);
  });

  it('neutraliza inyección de fórmulas en nombre, lugar y piedras', () => {
    const q = sampleQuote({
      customer: {
        nombre: '=HYPERLINK("http://x")',
        telefono: '+525550100',
        correo: '@x@example.com',
      },
      works: { lugar: ' -2+3', codigoPostal: '74000', uso: '', notas: '' },
    });
    const csv = quotesToCsv([q]);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv).toContain('"+525550100"'); // teléfono con lada: sin prefijo
    expect(csv).toContain(`"' -2+3"`);
    expect(csv).toContain(`"'@x@example.com"`);
  });

  it('solo trae las columnas pedidas y los importes con 2 decimales', () => {
    const csv = quotesToCsv([sampleQuote()]);
    const head = csv.slice(1).split('\r\n')[0]!;
    expect(head.split('","')).toHaveLength(12);
    expect(csv).toContain('"2761.40"');
    expect(csv).toContain('"1500.05"');
    expect(csv).not.toContain('notas internas');
    expect(csv).not.toContain('userAgent');
  });

  it('sin finalQuote deja total y flete vacíos', () => {
    const q = sampleQuote();
    delete (q as { finalQuote?: unknown }).finalQuote;
    const row = quotesToCsv([q]).slice(1).split('\r\n')[1]!;
    expect(row).toContain('"",""');
  });

  it('respeta el tope de filas', () => {
    expect(MAX_EXPORT_ROWS).toBe(5000);
    const rows = Array.from({ length: MAX_EXPORT_ROWS + 1 }, () => sampleQuote());
    expect(() => quotesToCsv(rows)).toThrow(RangeError);
    expect(() => quotesToCsv(rows.slice(0, MAX_EXPORT_ROWS))).not.toThrow();
  });
});
