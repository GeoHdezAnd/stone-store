import { App, Tags } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { AdminSiteStack, buildAdminCsp } from './admin-site-stack.js';

function synth(name: 'dev' | 'prod', emulated = false, apiOrigin?: string): Template {
  const app = new App();
  const stack = new AdminSiteStack(app, 'Prueba', {
    deploy: { name, account: undefined, region: 'us-east-1', emulated },
    ...(apiOrigin === undefined ? {} : { apiOrigin }),
  });
  Tags.of(app).add('Project', 'canteras-naturales');
  Tags.of(app).add('Env', name);
  return Template.fromStack(stack);
}

function csp(template: Template): string {
  const policies = template.findResources('AWS::CloudFront::ResponseHeadersPolicy');
  const [policy] = Object.values(policies);
  const config = (
    policy as { Properties: { ResponseHeadersPolicyConfig: Record<string, unknown> } }
  ).Properties.ResponseHeadersPolicyConfig;
  const value = (
    config['SecurityHeadersConfig'] as { ContentSecurityPolicy: { ContentSecurityPolicy: string } }
  ).ContentSecurityPolicy.ContentSecurityPolicy;
  return value;
}

describe('buildAdminCsp', () => {
  it('cierra todo por defecto y abre solo lo que el dashboard necesita', () => {
    const value = buildAdminCsp({ region: 'us-east-1' });
    expect(value).toContain("default-src 'self'");
    expect(value).toContain("script-src 'self'");
    expect(value).toContain("style-src 'self'");
    expect(value).toContain("frame-ancestors 'none'");
    expect(value).toContain("base-uri 'self'");
    expect(value).toContain("form-action 'self'");
    expect(value).toContain("object-src 'none'");
  });

  it('connect-src incluye la API, Cognito y el bucket de media de la región', () => {
    const value = buildAdminCsp({ region: 'us-east-1' });
    const connect = value.split('; ').find((d) => d.startsWith('connect-src')) ?? '';
    expect(connect).toContain("'self'");
    expect(connect).toContain('https://*.execute-api.us-east-1.amazonaws.com');
    expect(connect).toContain('https://cognito-idp.us-east-1.amazonaws.com');
    expect(connect).toContain('https://*.s3.us-east-1.amazonaws.com');
  });

  it('permite sustituir el origen de la API', () => {
    const value = buildAdminCsp({ region: 'us-east-1', apiOrigin: 'https://api.ejemplo.mx' });
    expect(value).toContain('https://api.ejemplo.mx');
    expect(value).not.toContain('execute-api');
  });

  it('img-src no abre todo https: solo el bucket de media', () => {
    const value = buildAdminCsp({ region: 'us-east-1' });
    const img = value.split('; ').find((d) => d.startsWith('img-src')) ?? '';
    expect(img).not.toMatch(/(^|\s)https:(\s|$)/);
    expect(img).toContain('https://*.s3.us-east-1.amazonaws.com');
  });

  it('rechaza orígenes de API que no sean https', () => {
    expect(() =>
      buildAdminCsp({ region: 'us-east-1', apiOrigin: 'http://api.ejemplo.mx' }),
    ).toThrow(/https/);
    expect(() =>
      buildAdminCsp({ region: 'us-east-1', apiOrigin: 'https://a.mx; script-src *' }),
    ).toThrow();
  });
});

describe('AdminSiteStack', () => {
  it('usa bucket privado con OAC (sin OAI)', () => {
    const template = synth('prod');
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    template.resourceCountIs('AWS::CloudFront::CloudFrontOriginAccessIdentity', 0);
  });

  it('redirige 403 y 404 a /index.html con 200 y TTL corto (SPA)', () => {
    synth('prod').hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({
            ErrorCode: 403,
            ResponseCode: 200,
            ResponsePagePath: '/index.html',
            ErrorCachingMinTTL: 10,
          }),
          Match.objectLike({
            ErrorCode: 404,
            ResponseCode: 200,
            ResponsePagePath: '/index.html',
            ErrorCachingMinTTL: 10,
          }),
        ]),
      }),
    });
  });

  it.each(['dev', 'prod'] as const)('en %s real aplica CSP, HSTS y noindex', (name) => {
    const template = synth(name);
    template.resourceCountIs('AWS::CloudFront::ResponseHeadersPolicy', 1);
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          ContentSecurityPolicy: {
            Override: true,
            ContentSecurityPolicy: Match.stringLikeRegexp("default-src 'self'"),
          },
          StrictTransportSecurity: Match.objectLike({ Override: true, IncludeSubdomains: true }),
          ContentTypeOptions: { Override: true },
          FrameOptions: { FrameOption: 'DENY', Override: true },
          ReferrerPolicy: { ReferrerPolicy: 'strict-origin-when-cross-origin', Override: true },
        }),
        CustomHeadersConfig: {
          Items: Match.arrayWith([
            { Header: 'X-Robots-Tag', Value: 'noindex, nofollow', Override: true },
          ]),
        },
      }),
    });
    expect(csp(template)).toContain("frame-ancestors 'none'");
  });

  it('con Floci no crea la política propia (usa la administrada)', () => {
    const template = synth('dev', true);
    template.resourceCountIs('AWS::CloudFront::ResponseHeadersPolicy', 0);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CustomErrorResponses: Match.anyValue(),
        DefaultCacheBehavior: Match.objectLike({ ResponseHeadersPolicyId: Match.anyValue() }),
      }),
    });
  });

  it('acepta un origen de API propio en la CSP', () => {
    expect(csp(synth('prod', false, 'https://api.ejemplo.mx'))).toContain('https://api.ejemplo.mx');
  });

  it('en dev es efímero y en prod conserva el bucket', () => {
    synth('dev').hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
    synth('prod').hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
  });

  it('con Floci no crea la Lambda de autodelete', () => {
    synth('dev', true).resourceCountIs('Custom::S3AutoDeleteObjects', 0);
  });

  it('etiqueta con Project y Env', () => {
    synth('dev').hasResourceProperties('AWS::S3::Bucket', {
      Tags: Match.arrayWith([
        { Key: 'Env', Value: 'dev' },
        { Key: 'Project', Value: 'canteras-naturales' },
      ]),
    });
  });

  it('expone las salidas que usan los scripts', () => {
    const template = synth('dev');
    template.hasOutput('BucketName', {});
    template.hasOutput('DistributionId', {});
    template.hasOutput('DistributionDomainName', {});
  });

  it('no depende de otros stacks (ni importa salidas de la API)', () => {
    const template = synth('prod');
    expect(JSON.stringify(template.toJSON())).not.toContain('Fn::ImportValue');
    expect(Object.keys(template.toJSON()['Outputs'] as object).sort()).toEqual([
      'BucketName',
      'DistributionDomainName',
      'DistributionId',
    ]);
  });
});
