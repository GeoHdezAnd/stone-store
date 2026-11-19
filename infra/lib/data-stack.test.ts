import { App, Tags } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, it, expect } from 'vitest';

import { AUDIT_SCOPE_INDEX, DataStack } from './data-stack.js';

function synth(name: 'dev' | 'prod', emulated = false): Template {
  const app = new App();
  const stack = new DataStack(app, 'Prueba', {
    deploy: { name, account: undefined, region: 'us-east-1', emulated },
  });
  Tags.of(app).add('Project', 'canteras-naturales');
  Tags.of(app).add('Env', name);
  return Template.fromStack(stack);
}

// Cada tabla con su esquema de claves exacto (CLAUDE.md 6.2).
const TABLAS: Record<string, { name: string; type: 'HASH' | 'RANGE' }[]> = {
  Stones: [{ name: 'id', type: 'HASH' }],
  Projects: [{ name: 'id', type: 'HASH' }],
  Finishes: [{ name: 'id', type: 'HASH' }],
  Services: [{ name: 'id', type: 'HASH' }],
  Settings: [{ name: 'key', type: 'HASH' }],
  AuditLog: [
    { name: 'pk', type: 'HASH' },
    { name: 'sk', type: 'RANGE' },
  ],
  Publications: [{ name: 'version', type: 'HASH' }],
  Counters: [{ name: 'name', type: 'HASH' }],
  FreightConfig: [{ name: 'version', type: 'HASH' }],
};

describe('DataStack', () => {
  it('crea las 9 tablas', () => {
    synth('dev').resourceCountIs('AWS::DynamoDB::Table', 9);
  });

  it.each(Object.entries(TABLAS))('la tabla %s tiene su clave exacta', (_nombre, claves) => {
    const tablas = Object.values(synth('dev').findResources('AWS::DynamoDB::Table'));
    const keySchemas = tablas.map((t) =>
      (t.Properties.KeySchema as { AttributeName: string; KeyType: string }[]).map((k) => ({
        name: k.AttributeName,
        type: k.KeyType,
      })),
    );
    expect(keySchemas).toContainEqual(claves);
  });

  it('todas las tablas son PAY_PER_REQUEST', () => {
    const tablas = Object.values(synth('dev').findResources('AWS::DynamoDB::Table'));
    expect(tablas).toHaveLength(9);
    for (const t of tablas) expect(t.Properties.BillingMode).toBe('PAY_PER_REQUEST');
  });

  it('el ÚNICO índice secundario es el GSI disperso de AuditLog (scope + sk)', () => {
    const tablas = Object.values(synth('dev').findResources('AWS::DynamoDB::Table'));
    const conIndices = tablas.filter((t) => t.Properties.GlobalSecondaryIndexes !== undefined);
    expect(conIndices).toHaveLength(1);
    for (const t of tablas) expect(t.Properties.LocalSecondaryIndexes).toBeUndefined();
    const gsi = conIndices[0]!.Properties.GlobalSecondaryIndexes as Record<string, unknown>[];
    expect(gsi).toHaveLength(1);
    expect(gsi[0]).toMatchObject({
      IndexName: 'scope-sk-index',
      KeySchema: [
        { AttributeName: 'scope', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      // Sin `antes`/`despues` (pueden traer datos de contacto): solo quién y qué acción.
      Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['userId', 'accion'] },
    });
    // Es de AuditLog (clave pk + sk).
    expect(
      (conIndices[0]!.Properties.KeySchema as { AttributeName: string }[]).map(
        (k) => k.AttributeName,
      ),
    ).toEqual(['pk', 'sk']);
  });

  it('exporta el nombre del índice para el entorno de las Lambdas', () => {
    expect(AUDIT_SCOPE_INDEX).toBe('scope-sk-index');
  });

  it('en dev se borran con el stack y sin protección contra borrado', () => {
    const tablas = Object.values(synth('dev').findResources('AWS::DynamoDB::Table'));
    for (const t of tablas) {
      expect(t.DeletionPolicy).toBe('Delete');
      expect(t.Properties.DeletionProtectionEnabled).toBeFalsy();
      expect(t.Properties.PointInTimeRecoverySpecification).toBeUndefined();
    }
  });

  it('en prod se conservan, con protección contra borrado y PITR', () => {
    const tablas = Object.values(synth('prod').findResources('AWS::DynamoDB::Table'));
    expect(tablas).toHaveLength(9);
    for (const t of tablas) {
      expect(t.DeletionPolicy).toBe('Retain');
      expect(t.Properties.DeletionProtectionEnabled).toBe(true);
      expect(t.Properties.PointInTimeRecoverySpecification).toEqual({
        PointInTimeRecoveryEnabled: true,
      });
    }
  });

  it('en prod emulado no activa PITR (el emulador no lo soporta)', () => {
    const tablas = Object.values(synth('prod', true).findResources('AWS::DynamoDB::Table'));
    for (const t of tablas) {
      expect(t.Properties.PointInTimeRecoverySpecification).toBeUndefined();
    }
  });

  it.each(Object.keys(TABLAS))('expone la salida %sTableName', (nombre) => {
    synth('dev').hasOutput(`${nombre}TableName`, { Value: Match.anyValue() });
  });

  it('etiqueta las tablas con Project y Env', () => {
    synth('dev').hasResourceProperties('AWS::DynamoDB::Table', {
      Tags: Match.arrayWith([
        { Key: 'Env', Value: 'dev' },
        { Key: 'Project', Value: 'canteras-naturales' },
      ]),
    });
  });
});
