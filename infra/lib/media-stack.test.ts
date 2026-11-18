import { App, Tags } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { MediaStack } from './media-stack.js';

interface Opts {
  name?: 'dev' | 'prod';
  emulated?: boolean;
  allowedOrigins?: string[];
}

function synth(opts: Opts = {}): Template {
  const { name = 'dev', emulated = false, allowedOrigins = ['https://admin.ejemplo.mx'] } = opts;
  const app = new App();
  const stack = new MediaStack(app, 'Media', {
    deploy: { name, account: undefined, region: 'us-east-1', emulated },
    allowedOrigins,
  });
  Tags.of(app).add('Project', 'canteras-naturales');
  Tags.of(app).add('Env', name);
  return Template.fromStack(stack);
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
