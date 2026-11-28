import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { App, Tags } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { SiteStack } from '../site-stack.js';

function synth(name: 'dev' | 'prod', emulated = false): Template {
  return build(name, emulated).template;
}

function build(name: 'dev' | 'prod', emulated = false): { template: Template; stack: SiteStack } {
  const app = new App();
  const stack = new SiteStack(app, 'Prueba', {
    deploy: { name, account: undefined, region: 'us-east-1', emulated },
  });
  Tags.of(app).add('Project', 'canteras-naturales');
  Tags.of(app).add('Env', name);
  return { template: Template.fromStack(stack), stack };
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const CACHING_OPTIMIZED = '658327ea-f89d-4fab-a63d-7e88639e58f6';
const SECURITY_HEADERS_MANAGED = '67f7725c-6f97-4210-82d7-5512b31e9d03';

const distributionConfig = (t: Template): Json =>
  Object.values(t.findResources('AWS::CloudFront::Distribution'))[0]!.Properties.DistributionConfig;
const behaviors = (t: Template): Json[] => distributionConfig(t).CacheBehaviors as Json[];
const origins = (t: Template): Json[] => distributionConfig(t).Origins as Json[];
const originOf = (t: Template, targetId: string): Json =>
  origins(t).find((o) => o['Id'] === targetId)!;

describe('SiteStack', () => {
  it('en dev crea el sitio efímero (bucket se borra con el stack)', () => {
    synth('dev').hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
  });

  it('en dev con Floci borra el bucket pero sin la Lambda de autodelete (no funciona en el emulador)', () => {
    const template = synth('dev', true);
    template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 0);
  });

  it('en dev contra AWS real conserva autoDeleteObjects', () => {
    synth('dev').resourceCountIs('Custom::S3AutoDeleteObjects', 1);
  });

  it('en prod conserva el bucket', () => {
    synth('prod').hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
  });

  it('etiqueta los recursos con Project y Env', () => {
    synth('dev').hasResourceProperties('AWS::S3::Bucket', {
      Tags: Match.arrayWith([
        { Key: 'Env', Value: 'dev' },
        { Key: 'Project', Value: 'canteras-naturales' },
      ]),
    });
  });

  it('expone las salidas que usa el script de publicación', () => {
    const template = synth('dev');
    template.hasOutput('BucketName', {});
    template.hasOutput('DistributionId', {});
    template.hasOutput('DistributionDomainName', {});
  });
});

describe('SiteStack: fotos y catálogo por la misma distribución', () => {
  it('tiene exactamente los comportamientos /media/* y /published/*', () => {
    const paths = behaviors(synth('dev')).map((b) => b['PathPattern']);
    expect(paths).toEqual(['/media/*', '/published/*']);
  });

  it.each(['/media/*', '/published/*'])(
    '%s es de solo lectura, https y con caché optimizada',
    (p) => {
      const b = behaviors(synth('dev')).find((x) => x['PathPattern'] === p)!;
      expect(b['AllowedMethods']).toEqual(['GET', 'HEAD']);
      expect(b['ViewerProtocolPolicy']).toBe('redirect-to-https');
      expect(b['CachePolicyId']).toBe(CACHING_OPTIMIZED);
      expect(b['CachedMethods']).toBeUndefined();
    },
  );

  it('el comportamiento por defecto no cambia de permisos y no lleva función', () => {
    const d = distributionConfig(synth('dev'))['DefaultCacheBehavior'] as Json;
    expect(d['FunctionAssociations']).toBeUndefined();
    expect(d['AllowedMethods']).toBeUndefined();
    expect(d['ViewerProtocolPolicy']).toBe('redirect-to-https');
  });

  it('la función de /media/* es cloudfront-js-2.0, de tipo viewer-request, y SOLO está en /media/*', () => {
    const t = synth('dev');
    const fns = Object.values(t.findResources('AWS::CloudFront::Function'));
    expect(fns).toHaveLength(1);
    expect(fns[0]!.Properties.FunctionConfig.Runtime).toBe('cloudfront-js-2.0');
    const withFn = behaviors(t).filter((b) => b['FunctionAssociations'] !== undefined);
    expect(withFn.map((b) => b['PathPattern'])).toEqual(['/media/*']);
    const assoc = withFn[0]!['FunctionAssociations'] as Json[];
    expect(assoc).toHaveLength(1);
    expect(assoc[0]!['EventType']).toBe('viewer-request');
    expect(JSON.stringify(assoc[0]!['FunctionARN'])).toContain('MediaViewerRequest');
    expect(distributionConfig(t)['DefaultCacheBehavior']['FunctionAssociations']).toBeUndefined();
  });

  it('el código de la función desplegada es el archivo del repo (no una copia)', () => {
    const fn = Object.values(synth('dev').findResources('AWS::CloudFront::Function'))[0]!;
    const archivo = readFileSync(
      join(import.meta.dirname, '..', '..', 'functions', 'media-viewer-request.js'),
      'utf8',
    );
    expect(fn.Properties.FunctionCode).toBe(archivo);
  });

  it('cada origen usa OAC y no hay ninguna OAI', () => {
    const t = synth('dev');
    expect(origins(t)).toHaveLength(3);
    for (const o of origins(t)) {
      expect(o['OriginAccessControlId'], `origen ${String(o['Id'])} sin OAC`).toBeDefined();
      expect(o['S3OriginConfig']['OriginAccessIdentity']).toBe('');
    }
    t.resourceCountIs('AWS::CloudFront::CloudFrontOriginAccessIdentity', 0);
    t.resourceCountIs('AWS::CloudFront::OriginAccessControl', 2);
  });

  it('los orígenes de media y publish apuntan a los buckets de nombre fijo', () => {
    const t = synth('dev');
    const media = JSON.stringify(
      originOf(t, behaviors(t).find((b) => b['PathPattern'] === '/media/*')!['TargetOriginId'])[
        'DomainName'
      ],
    );
    const publish = JSON.stringify(
      originOf(t, behaviors(t).find((b) => b['PathPattern'] === '/published/*')!['TargetOriginId'])[
        'DomainName'
      ],
    );
    expect(media).toMatch(/canteras-media-dev.*AWS::AccountId.*AWS::Region/);
    expect(publish).toMatch(/canteras-publish-dev.*AWS::AccountId.*AWS::Region/);
    expect(media).not.toContain('Fn::GetAtt');
    expect(publish).not.toContain('Fn::GetAtt');
  });

  it('no importa ni exporta nada de otros stacks (el sitio se despliega primero)', () => {
    const t = synth('prod');
    expect(JSON.stringify(t.toJSON())).not.toContain('Fn::ImportValue');
    expect(t.toJSON().Outputs?.['DistributionId']?.Export).toBeUndefined();
  });

  it('la política de bucket del sitio no cambia: solo el OAC de SU distribución', () => {
    const t = synth('dev');
    const policies = Object.values(t.findResources('AWS::S3::BucketPolicy'));
    // Solo el bucket del sitio es de este stack: los importados no reciben política aquí.
    expect(policies).toHaveLength(1);
  });

  it('/media/* usa una política de cabeceras propia con CSP estricta y nosniff', () => {
    const t = synth('dev');
    const mediaBehavior = behaviors(t).find((b) => b['PathPattern'] === '/media/*')!;
    const policies = Object.entries(t.findResources('AWS::CloudFront::ResponseHeadersPolicy'));
    expect(policies).toHaveLength(1);
    const [logicalId, policy] = policies[0]!;
    expect(mediaBehavior['ResponseHeadersPolicyId']).toEqual({ Ref: logicalId });
    const sec = policy.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig as Json;
    expect(sec['ContentSecurityPolicy']).toEqual({
      ContentSecurityPolicy: "default-src 'none'; img-src 'self'; sandbox",
      Override: true,
    });
    expect(sec['ContentTypeOptions']).toEqual({ Override: true });
    expect(sec['FrameOptions']).toEqual({ FrameOption: 'DENY', Override: true });
    expect(sec['ReferrerPolicy']).toEqual({ ReferrerPolicy: 'no-referrer', Override: true });
    expect(sec['StrictTransportSecurity']).toMatchObject({
      Override: true,
      IncludeSubdomains: true,
    });
    // El origen ya fija Content-Type y Cache-Control: la política no los pisa.
    expect(policy.Properties.ResponseHeadersPolicyConfig.CustomHeadersConfig).toBeUndefined();
    expect(JSON.stringify(policy)).not.toContain('Cross-Origin-Resource-Policy');
  });

  it('/published/* usa la política administrada SECURITY_HEADERS y ninguna función', () => {
    const b = behaviors(synth('dev')).find((x) => x['PathPattern'] === '/published/*')!;
    expect(b['ResponseHeadersPolicyId']).toBe(SECURITY_HEADERS_MANAGED);
    expect(b['FunctionAssociations']).toBeUndefined();
  });
});

describe('SiteStack: orígenes, errores y avisos', () => {
  const originFor = (t: Template, path: string): Json => {
    const b = behaviors(t).find((x) => x['PathPattern'] === path)!;
    return originOf(t, b['TargetOriginId']);
  };

  it.each([
    ['/media/*', 'canteras-media-dev'],
    ['/published/*', 'canteras-publish-dev'],
  ])(
    'el origen de %s no lleva OriginPath (la clave ya viene completa) y usa S3 con OAC',
    (path, bucket) => {
      const o = originFor(synth('dev'), path);
      expect('OriginPath' in o, 'OriginPath no debe existir, ni vacío').toBe(false);
      expect(o['S3OriginConfig']).toEqual({ OriginAccessIdentity: '' });
      expect(JSON.stringify(o['DomainName'])).toMatch(
        new RegExp(`${bucket}.*AWS::AccountId.*AWS::Region.*[.]s3[.].*AWS::URLSuffix`),
      );
      expect(o['CustomOriginConfig']).toBeUndefined();
      expect(o['OriginCustomHeaders']).toBeUndefined();
    },
  );

  it('el sitio público NO enmascara errores: sin CustomErrorResponses (403/404 de fotos y catálogo se ven)', () => {
    for (const emulated of [false, true]) {
      expect(distributionConfig(synth('dev', emulated))['CustomErrorResponses']).toBeUndefined();
    }
    expect(distributionConfig(synth('prod'))['CustomErrorResponses']).toBeUndefined();
  });

  it('no emite el aviso updateImportedBucketPolicyOac (está reconocido a propósito)', () => {
    for (const emulated of [false, true]) {
      const { stack } = build('dev', emulated);
      expect(
        Annotations.fromStack(stack).findWarning(
          '*',
          Match.stringLikeRegexp('updateImportedBucketPolicyOac'),
        ),
      ).toEqual([]);
      expect(Annotations.fromStack(stack).findWarning('*', Match.anyValue())).toEqual([]);
    }
  });
});

describe('SiteStack con emulador (Floci)', () => {
  it('no crea la función ni políticas de cabeceras propias (Floci no las soporta)', () => {
    const t = synth('dev', true);
    t.resourceCountIs('AWS::CloudFront::Function', 0);
    t.resourceCountIs('AWS::CloudFront::ResponseHeadersPolicy', 0);
  });

  it('omite /media/* (sin la función nada filtraría la ruta) y conserva /published/*', () => {
    const t = synth('dev', true);
    expect(behaviors(t).map((b) => b['PathPattern'])).toEqual(['/published/*']);
    expect(JSON.stringify(t.toJSON())).not.toContain('canteras-media');
  });

  it('sigue sin importar nada de otros stacks', () => {
    expect(JSON.stringify(synth('dev', true).toJSON())).not.toContain('Fn::ImportValue');
  });
});
