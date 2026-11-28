import { App, Tags } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { PublishStack } from '../publish-stack.js';

interface Opts {
  name?: 'dev' | 'prod';
  emulated?: boolean;
  siteDistributionId?: string;
}

function build(opts: Opts = {}): { template: Template; stack: PublishStack } {
  const { name = 'dev', emulated = false, siteDistributionId } = opts;
  const app = new App();
  const stack = new PublishStack(app, 'Publish', {
    deploy: { name, account: undefined, region: 'us-east-1', emulated },
    ...(siteDistributionId === undefined ? {} : { siteDistributionId }),
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

describe('PublishStack: bucket de publicación', () => {
  it('es un bucket propio y único (nunca el del sitio, que `sync --delete` vaciaría)', () => {
    synth().resourceCountIs('AWS::S3::Bucket', 1);
  });

  it('bloquea TODO el acceso público', () => {
    synth().hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('tiene el versionado de S3 activado (rescata un objeto sobrescrito o borrado)', () => {
    synth().hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
    });
  });

  it('cifra en reposo con SSE-S3 y deshabilita las ACL', () => {
    const t = synth();
    t.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          Match.objectLike({ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }),
        ],
      },
      OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
    });
  });

  it('exige SSL y no hay política que permita acceso público', () => {
    const t = synth();
    const politicas = Object.values(t.findResources('AWS::S3::BucketPolicy'));
    expect(politicas).toHaveLength(1);
    const st = politicas[0]!.Properties.PolicyDocument.Statement as Json[];
    expect(
      st.some(
        (s) => s['Effect'] === 'Deny' && s['Condition']?.Bool?.['aws:SecureTransport'] === 'false',
      ),
    ).toBe(true);
    for (const s of st) {
      if (s['Effect'] === 'Allow') expect(JSON.stringify(s['Principal'])).not.toContain('"*"');
    }
  });

  it('sin CORS ni sitio web: el navegador no lo lee directo', () => {
    const props = bucket(synth()).Properties;
    expect(props.CorsConfiguration).toBeUndefined();
    expect(props.WebsiteConfiguration).toBeUndefined();
  });

  it('aborta multiparte a 1 día y expira SOLO las versiones no vigentes (a 90 días)', () => {
    synth().hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: [
          Match.objectLike({
            Status: 'Enabled',
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
            NoncurrentVersionExpiration: { NoncurrentDays: 90 },
          }),
        ],
      },
    });
    // Nunca se expira el objeto vigente: las versiones publicadas son el historial de reversión.
    const reglas = bucket(synth()).Properties.LifecycleConfiguration.Rules as Json[];
    for (const r of reglas) {
      expect(r['ExpirationInDays']).toBeUndefined();
      expect(r['ExpirationDate']).toBeUndefined();
    }
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

describe('PublishStack: borrado por entorno', () => {
  it('dev real: se destruye con el stack y vacía los objetos', () => {
    const t = synth({ name: 'dev', emulated: false });
    t.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete', UpdateReplacePolicy: 'Delete' });
    t.resourceCountIs('Custom::S3AutoDeleteObjects', 1);
  });

  it('dev emulado: se destruye pero SIN autodelete', () => {
    const t = synth({ name: 'dev', emulated: true });
    t.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
    t.resourceCountIs('Custom::S3AutoDeleteObjects', 0);
  });

  it('prod: se conserva y nunca autodelete', () => {
    const t = synth({ name: 'prod' });
    t.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
    t.resourceCountIs('Custom::S3AutoDeleteObjects', 0);
  });
});

describe('PublishStack: salidas', () => {
  it('expone PublishBucketName', () => {
    synth().hasOutput('PublishBucketName', { Value: Match.anyValue() });
  });
});

describe('PublishStack: lectura por la distribución del sitio (OAC)', () => {
  const ID = 'E1ABCDEF234567';
  const statements = (t: Template): Json[] =>
    Object.values(t.findResources('AWS::S3::BucketPolicy')).flatMap(
      (p) => p.Properties.PolicyDocument.Statement as Json[],
    );
  const cdn = (t: Template): Json[] =>
    statements(t).filter((s) =>
      JSON.stringify(s['Principal']).includes('cloudfront.amazonaws.com'),
    );

  it('el bucket tiene nombre fijo por entorno, cuenta y región', () => {
    expect(JSON.stringify(bucket(synth()).Properties.BucketName)).toMatch(
      /canteras-publish-dev.*AWS::AccountId.*AWS::Region/,
    );
  });

  it('con id: un solo statement, s3:GetObject, SourceArn exacto y SOLO published/catalog.json', () => {
    const [st, ...rest] = cdn(synth({ siteDistributionId: ID }));
    expect(rest).toEqual([]);
    expect(st!['Effect']).toBe('Allow');
    expect(st!['Principal']).toEqual({ Service: 'cloudfront.amazonaws.com' });
    expect(st!['Action']).toBe('s3:GetObject');
    expect(Object.keys(st!['Condition'])).toEqual(['StringEquals']);
    expect(JSON.stringify(st!['Condition'])).toMatch(/:distribution\/E1ABCDEF234567/);
    const res = st!['Resource'] as Json;
    const parts = (res['Fn::Join'] as [string, unknown[]])[1];
    expect(parts[parts.length - 1]).toBe('/published/catalog.json');
    expect(JSON.stringify(res)).not.toContain('/v');
  });

  it('sin id: ningún statement de CloudFront y avisa que habrá 403', () => {
    const { template, stack } = build();
    expect(cdn(template)).toEqual([]);
    Annotations.fromStack(stack).hasWarning(
      '*',
      Match.stringLikeRegexp('SITE_DISTRIBUTION_ID.*403'),
    );
  });

  it('con emulador y sin id: sin statement ni aviso', () => {
    const { template, stack } = build({ emulated: true });
    expect(cdn(template)).toEqual([]);
    Annotations.fromStack(stack).hasNoWarning('*', Match.stringLikeRegexp('SITE_DISTRIBUTION_ID'));
  });

  it('un id vacío no crea statement y uno inválido lanza', () => {
    expect(cdn(synth({ siteDistributionId: '' }))).toEqual([]);
    expect(() => synth({ siteDistributionId: 'xyz' })).toThrow(/SITE_DISTRIBUTION_ID/);
  });
});
