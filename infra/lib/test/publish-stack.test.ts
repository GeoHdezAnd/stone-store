import { App, Tags } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { PublishStack } from '../publish-stack.js';

interface Opts {
  name?: 'dev' | 'prod';
  emulated?: boolean;
}

function synth(opts: Opts = {}): Template {
  const { name = 'dev', emulated = false } = opts;
  const app = new App();
  const stack = new PublishStack(app, 'Publish', {
    deploy: { name, account: undefined, region: 'us-east-1', emulated },
  });
  Tags.of(app).add('Project', 'canteras-naturales');
  Tags.of(app).add('Env', name);
  return Template.fromStack(stack);
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
