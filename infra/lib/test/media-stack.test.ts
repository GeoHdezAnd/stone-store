import { readFileSync } from 'node:fs';

import { App, Tags } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import {
  MediaStack,
  SHARP_VERSION,
  VARIANTS_MEMORY_MB,
  parseReservedConcurrency,
  VARIANTS_TIMEOUT_SECONDS,
  sharpInstallCommand,
} from '../media-stack.js';

interface Opts {
  name?: 'dev' | 'prod';
  emulated?: boolean;
  allowedOrigins?: string[];
  packSharp?: boolean;
  /** Por defecto `true` en pruebas (sin red); los tests de la comprobación lo ponen en `false`. */
  skipSharpCheck?: boolean;
  reservedConcurrency?: number;
}

function build(opts: Opts = {}): { template: Template; stack: MediaStack } {
  const {
    name = 'dev',
    emulated = false,
    allowedOrigins = ['https://admin.ejemplo.mx'],
    packSharp,
    skipSharpCheck = true,
    reservedConcurrency,
  } = opts;
  // `bundling-stacks: []` evita ejecutar esbuild (y cualquier red) al sintetizar en las pruebas.
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new MediaStack(app, 'Media', {
    deploy: { name, account: undefined, region: 'us-east-1', emulated },
    allowedOrigins,
    ...(packSharp === undefined ? {} : { packSharp }),
    skipSharpCheck,
    ...(reservedConcurrency === undefined ? {} : { reservedConcurrency }),
  });
  Tags.of(app).add('Project', 'canteras-naturales');
  Tags.of(app).add('Env', name);
  return { template: Template.fromStack(stack), stack };
}

function synth(opts: Opts = {}): Template {
  return build(opts).template;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const bucket = (t: Template): Json => Object.values(t.findResources('AWS::S3::Bucket'))[0]!;

describe('MediaStack: bucket privado', () => {
  it('hay un solo bucket y bloquea TODO el acceso público', () => {
    const t = synth();
    t.resourceCountIs('AWS::S3::Bucket', 1);
    t.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('cifra en reposo con claves administradas por S3 (SSE-S3)', () => {
    synth().hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          Match.objectLike({ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }),
        ],
      },
    });
  });

  it('exige SSL con una política que deniega s3:* sin aws:SecureTransport', () => {
    const t = synth();
    const politicas = Object.values(t.findResources('AWS::S3::BucketPolicy'));
    expect(politicas).toHaveLength(1);
    const st = politicas[0]!.Properties.PolicyDocument.Statement as Json[];
    const ssl = st.find(
      (s) => s['Effect'] === 'Deny' && s['Condition']?.Bool?.['aws:SecureTransport'] === 'false',
    );
    expect(ssl, 'falta la sentencia enforceSSL').toBeDefined();
    expect(ssl!['Principal']).toEqual({ AWS: '*' });
  });

  it('no hay ninguna política que permita acceso público (Principal *)', () => {
    const t = synth();
    for (const p of Object.values(t.findResources('AWS::S3::BucketPolicy'))) {
      for (const s of p.Properties.PolicyDocument.Statement as Json[]) {
        if (s['Effect'] === 'Allow') {
          expect(JSON.stringify(s['Principal'])).not.toContain('"*"');
        }
      }
    }
  });

  it('sin versionado y sin ACL públicas ni sitio web', () => {
    const props = bucket(synth()).Properties;
    expect(props.VersioningConfiguration).toBeUndefined();
    expect(props.AccessControl).toBeUndefined();
    expect(props.WebsiteConfiguration).toBeUndefined();
  });

  it('deshabilita las ACL (BucketOwnerEnforced) de forma explícita', () => {
    synth().hasResourceProperties('AWS::S3::Bucket', {
      OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
    });
  });

  it('aborta las cargas multiparte incompletas a 1 día', () => {
    synth().hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: [
          Match.objectLike({
            Status: 'Enabled',
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
          }),
        ],
      },
    });
  });

  it('etiqueta con Project y Env', () => {
    synth().hasResourceProperties('AWS::S3::Bucket', {
      Tags: Match.arrayWith([
        { Key: 'Env', Value: 'dev' },
        { Key: 'Project', Value: 'canteras-naturales' },
      ]),
    });
  });
});

describe('MediaStack: CORS del bucket', () => {
  const reglas = (t: Template): Json[] => bucket(t).Properties.CorsConfiguration.CorsRules;

  it('una sola regla: orígenes exactos, solo PUT, content-type y content-length, expone ETag', () => {
    const r = reglas(synth({ allowedOrigins: ['https://a.mx', 'https://b.mx'] }));
    expect(r).toHaveLength(1);
    expect(r[0]).toEqual({
      AllowedOrigins: ['https://a.mx', 'https://b.mx'],
      AllowedMethods: ['PUT'],
      AllowedHeaders: ['content-type', 'content-length'],
      ExposedHeaders: ['ETag'],
      MaxAge: 3000,
    });
  });

  it('nunca incluye * en ninguna parte del CORS', () => {
    for (const o of [{}, { name: 'prod' as const, allowedOrigins: ['https://admin.ejemplo.mx'] }]) {
      expect(JSON.stringify(bucket(synth(o)).Properties.CorsConfiguration)).not.toContain('*');
    }
  });

  it('sin orígenes (ni siquiera en dev) falla: un CORS vacío no tiene sentido', () => {
    expect(() => synth({ allowedOrigins: [] })).toThrow(/al menos un origen/);
  });

  it('rechaza orígenes inválidos (comodín, prod sin orígenes, localhost en prod)', () => {
    expect(() => synth({ allowedOrigins: ['*'] })).toThrow(/\*/);
    expect(() => synth({ name: 'prod', allowedOrigins: [] })).toThrow(/orígenes/);
    expect(() => synth({ name: 'prod', allowedOrigins: ['http://localhost:5173'] })).toThrow(
      /origen/i,
    );
  });
});

describe('MediaStack: borrado por entorno', () => {
  it('dev real: se destruye con el stack y vacía los objetos (custom resource de autodelete)', () => {
    const t = synth({ name: 'dev', emulated: false });
    t.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete', UpdateReplacePolicy: 'Delete' });
    t.resourceCountIs('Custom::S3AutoDeleteObjects', 1);
  });

  it('dev emulado: se destruye pero SIN autodelete (las custom resources no funcionan en Floci)', () => {
    const t = synth({ name: 'dev', emulated: true });
    t.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
    t.resourceCountIs('Custom::S3AutoDeleteObjects', 0);
  });

  it('prod: se conserva y nunca autodelete', () => {
    const t = synth({ name: 'prod', allowedOrigins: ['https://admin.ejemplo.mx'] });
    t.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
    t.resourceCountIs('Custom::S3AutoDeleteObjects', 0);
  });
});

describe('MediaStack: salidas', () => {
  it('expone MediaBucketName', () => {
    synth().hasOutput('MediaBucketName', { Value: Match.anyValue() });
  });
});

// ---------------------------------------------------------------------------------------------
// Variantes de imagen (fase 6.3): Lambda `MediaVariants` + notificación S3 -> Lambda.
// ---------------------------------------------------------------------------------------------

const ORIGIN_PREFIXES = ['stones/', 'projects/', 'finishes/'];

const variantsFn = (t: Template): Json => {
  const fns = Object.entries(t.findResources('AWS::Lambda::Function')).filter(([id]) =>
    id.startsWith('MediaVariants'),
  );
  expect(fns, 'debe haber exactamente una Lambda MediaVariants').toHaveLength(1);
  return fns[0]![1];
};

/** Políticas IAM inline del rol de MediaVariants (las del handler de notificaciones de CDK se excluyen). */
const variantsPolicyStatements = (t: Template): Json[] =>
  Object.entries(t.findResources('AWS::IAM::Policy'))
    .filter(([id]) => id.startsWith('MediaVariants'))
    .flatMap(([, p]) => p.Properties.PolicyDocument.Statement as Json[]);

describe('MediaStack: Lambda de variantes', () => {
  it('Node 22, arm64 (Graviton), 1024 MB y 60 s; SIN concurrencia reservada por defecto', () => {
    const props = variantsFn(synth()).Properties;
    expect(props.Runtime).toBe('nodejs22.x');
    expect(props.Architectures).toEqual(['arm64']);
    expect(props.MemorySize).toBe(1024);
    expect(props.Timeout).toBe(60);
    expect(props.ReservedConcurrentExecutions).toBeUndefined();
    expect(VARIANTS_MEMORY_MB).toBe(1024);
    expect(VARIANTS_TIMEOUT_SECONDS).toBe(60);
  });

  it('recibe el bucket por variable de entorno y no tiene ninguna otra', () => {
    const env = variantsFn(synth()).Properties.Environment.Variables;
    expect(Object.keys(env)).toEqual(['MEDIA_BUCKET']);
    expect(env.MEDIA_BUCKET.Ref).toMatch(/^Bucket/);
  });

  it('tiene su LogGroup explícito con retención de 1 semana', () => {
    const t = synth();
    const grupos = Object.entries(t.findResources('AWS::Logs::LogGroup')).filter(([id]) =>
      id.startsWith('MediaVariants'),
    );
    expect(grupos).toHaveLength(1);
    expect(grupos[0]![1].Properties.RetentionInDays).toBe(7);
  });

  it('reintenta una sola vez y descarta eventos de más de 1 hora (sin bucle de reintentos)', () => {
    synth().hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      MaximumRetryAttempts: 1,
      MaximumEventAgeInSeconds: 3600,
    });
  });

  it('etiqueta con Project y Env', () => {
    expect(variantsFn(synth()).Properties.Tags).toEqual(
      expect.arrayContaining([
        { Key: 'Env', Value: 'dev' },
        { Key: 'Project', Value: 'canteras-naturales' },
      ]),
    );
  });
});

describe('MediaStack: IAM de mínimo privilegio de la Lambda de variantes', () => {
  const statements = variantsPolicyStatements(synth());

  it('GetObject sobre los prefijos de originales y PutObject SOLO sobre las variantes', () => {
    const acciones = statements.flatMap((s) =>
      Array.isArray(s['Action']) ? s['Action'] : [s['Action']],
    );
    expect(new Set(acciones)).toEqual(new Set(['s3:GetObject', 's3:PutObject']));
    const prefijos = (accion: string): string[] =>
      statements
        .filter((s) => [s['Action']].flat().includes(accion))
        .flatMap((s) => [s['Resource']].flat())
        .map((r) => {
          const parts = (r as Json)['Fn::Join'][1] as unknown[];
          return String(parts[parts.length - 1]);
        })
        .sort();
    expect(prefijos('s3:GetObject')).toEqual(ORIGIN_PREFIXES.map((p) => `/${p}*`).sort());
    // PutObject no puede sobrescribir originales: solo claves `<prefijo>*/*-<ancho>w.webp`.
    const variantes = ORIGIN_PREFIXES.flatMap((p) =>
      [480, 960, 1600].map((w) => `/${p}*/*-${w}w.webp`),
    ).sort();
    expect(prefijos('s3:PutObject')).toEqual(variantes);
    expect(variantes).toHaveLength(9);
  });

  it('ninguna sentencia usa Resource "*" ni acciones comodín', () => {
    for (const s of statements) {
      expect(JSON.stringify(s['Resource'])).not.toBe('"*"');
      expect([s['Action']].flat().some((a) => String(a).includes('*'))).toBe(false);
      expect(s['Effect']).toBe('Allow');
    }
  });

  it('no puede listar ni borrar, ni toca DynamoDB, SES ni KMS', () => {
    const texto = JSON.stringify(statements);
    for (const prohibido of ['s3:List', 's3:Delete', 'dynamodb', 'ses:', 'kms:', 'ssm:']) {
      expect(texto).not.toContain(prohibido);
    }
  });
});

describe('MediaStack: notificación S3 -> Lambda', () => {
  const notif = (t: Template): Json[] => {
    const recursos = Object.values(t.findResources('Custom::S3BucketNotifications'));
    expect(recursos).toHaveLength(1);
    return recursos[0]!.Properties.NotificationConfiguration.LambdaFunctionConfigurations;
  };

  it('una notificación ObjectCreated por cada prefijo de originales', () => {
    const cfgs = notif(synth());
    expect(cfgs).toHaveLength(ORIGIN_PREFIXES.length);
    const prefijos = cfgs.map((c) => {
      expect(c['Events']).toEqual(['s3:ObjectCreated:*']);
      const reglas = c['Filter'].Key.FilterRules as Json[];
      expect(reglas).toHaveLength(1);
      expect(reglas[0]!['Name']).toBe('prefix');
      return reglas[0]!['Value'];
    });
    expect(prefijos.sort()).toEqual([...ORIGIN_PREFIXES].sort());
  });

  it('nunca notifica sin filtro de prefijo (no se procesa el bucket entero)', () => {
    for (const c of notif(synth())) expect(c['Filter']).toBeDefined();
  });

  it('S3 solo puede invocar la Lambda desde ESTE bucket y ESTA cuenta', () => {
    synth().hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      Principal: 's3.amazonaws.com',
      SourceAccount: Match.anyValue(),
      SourceArn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^Bucket'), 'Arn'] },
    });
  });

  it('con emulador la Lambda existe pero NO hay notificación ni permiso de S3', () => {
    const t = synth({ emulated: true });
    expect(variantsFn(t)).toBeDefined();
    t.resourceCountIs('Custom::S3BucketNotifications', 0);
    const permisos = Object.values(t.findResources('AWS::Lambda::Permission')).filter(
      (p) => p.Properties.Principal === 's3.amazonaws.com',
    );
    expect(permisos).toHaveLength(0);
  });
});

describe('MediaStack: empaquetado de sharp', () => {
  const sinBanderas = { skipSharpCheck: false } as const;

  it('fuera del emulador SIN packSharp NO sintetiza: lanza un error claro en español', () => {
    expect(() => build(sinBanderas)).toThrow(/packSharp=true/);
    expect(() => build(sinBanderas)).toThrow(/Lambda.*rota|no funcionaría|fallaría/is);
    expect(() => build({ ...sinBanderas, packSharp: false })).toThrow(/packSharp/);
  });

  it('fuera del emulador CON packSharp sintetiza sin avisos de sharp', () => {
    const con = build({ ...sinBanderas, packSharp: true });
    Annotations.fromStack(con.stack).hasNoWarning('*', Match.stringLikeRegexp('sharp'));
  });

  it('skipSharpCheck permite synth/diff sin red pero deja un WARNING (no sirve para desplegar)', () => {
    const skip = build({ skipSharpCheck: true });
    Annotations.fromStack(skip.stack).hasWarning('*', Match.stringLikeRegexp('NO desplegar'));
  });

  it('packSharp y skipSharpCheck juntos: gana packSharp, sin aviso', () => {
    const ambos = build({ packSharp: true, skipSharpCheck: true });
    Annotations.fromStack(ambos.stack).hasNoWarning('*', Match.stringLikeRegexp('sharp'));
  });

  it('con emulador no lanza ni avisa (la Lambda nunca se invoca)', () => {
    const emu = build({ emulated: true, skipSharpCheck: false });
    Annotations.fromStack(emu.stack).hasNoWarning('*', Match.stringLikeRegexp('sharp'));
  });

  it('el comando instala sharp EXACTO para linux, arm64 y glibc (la plataforma del runtime)', () => {
    const cmd = sharpInstallCommand('/out');
    expect(cmd).toContain(`sharp@${SHARP_VERSION}`);
    for (const flag of ['--os=linux', '--cpu=arm64', '--libc=glibc', '--prefix', '/out']) {
      expect(cmd).toContain(flag);
    }
    expect(cmd).not.toContain('darwin');
  });

  it('SHARP_VERSION coincide con la versión fijada en services/api/package.json', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../../services/api/package.json', import.meta.url), 'utf8'),
    ) as { devDependencies: Record<string, string> };
    expect(pkg.devDependencies['sharp']).toBe(SHARP_VERSION);
  });
});

describe('MediaStack: concurrencia reservada OPCIONAL', () => {
  it('con un valor válido se aplica a la Lambda', () => {
    expect(
      variantsFn(synth({ reservedConcurrency: 5 })).Properties.ReservedConcurrentExecutions,
    ).toBe(5);
  });

  it('sin valor no hay concurrencia reservada (no resta del pool de la cuenta)', () => {
    expect(variantsFn(synth()).Properties).not.toHaveProperty('ReservedConcurrentExecutions');
  });

  it('parseReservedConcurrency: vacío = apagado; entero >= 1 = valor; todo lo demás lanza', () => {
    expect(parseReservedConcurrency(undefined)).toBeUndefined();
    expect(parseReservedConcurrency('')).toBeUndefined();
    expect(parseReservedConcurrency('5')).toBe(5);
    expect(parseReservedConcurrency(7)).toBe(7);
    for (const malo of ['0', '-1', '1.5', 'abc', '5x', ' ', NaN, 0, 2.5, true, {}]) {
      expect(() => parseReservedConcurrency(malo), String(malo)).toThrow(
        /mediaVariantsReservedConcurrency/,
      );
    }
  });

  it('la pila rechaza un valor inválido aunque no pase por parseReservedConcurrency', () => {
    expect(() => synth({ reservedConcurrency: 0 })).toThrow(/entero/);
    expect(() => synth({ reservedConcurrency: 1.5 })).toThrow(/entero/);
  });
});
