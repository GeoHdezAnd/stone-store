import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { StaticSite, type StaticSiteProps } from './static-site.js';

function synth(ephemeral: boolean, autoDeleteObjects?: boolean): Template {
  const stack = new Stack(new App(), 'Prueba');
  new StaticSite(stack, 'Sitio', {
    ephemeral,
    ...(autoDeleteObjects === undefined ? {} : { autoDeleteObjects }),
  });
  return Template.fromStack(stack);
}

describe('StaticSite', () => {
  it('crea un bucket privado, cifrado y que exige HTTPS', () => {
    const template = synth(true);
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: Match.anyValue(),
    });
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  });

  it('accede al bucket con OAC y no con OAI', () => {
    const template = synth(true);
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    template.resourceCountIs('AWS::CloudFront::CloudFrontOriginAccessIdentity', 0);
  });

  it('solo permite leer el bucket al servicio de CloudFront', () => {
    const template = synth(true);
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Principal: { Service: 'cloudfront.amazonaws.com' },
            Action: 's3:GetObject',
            Condition: { StringEquals: { 'AWS:SourceArn': Match.anyValue() } },
          }),
        ]),
      },
    });
  });

  it('redirige a HTTPS y define index.html como objeto raíz', () => {
    const template = synth(true);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https' }),
      }),
    });
  });

  it('en dev (efímero) borra el bucket con el stack', () => {
    const template = synth(true);
    template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 1);
  });

  it('efímero con autoDeleteObjects apagado borra el bucket sin la Lambda de vaciado', () => {
    const template = synth(true, false);
    template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 0);
  });

  it('en prod conserva el bucket y no usa autoDeleteObjects', () => {
    const template = synth(false);
    template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 0);
  });

  describe('opciones opt-in', () => {
    function synthWith(options: Partial<StaticSiteProps>): Template {
      const stack = new Stack(new App(), 'Prueba');
      new StaticSite(stack, 'Sitio', { ephemeral: true, ...options });
      return Template.fromStack(stack);
    }

    it('por defecto no agrega errores personalizados ni política propia', () => {
      const template = synthWith({});
      template.resourceCountIs('AWS::CloudFront::ResponseHeadersPolicy', 0);
      const [dist] = Object.values(template.findResources('AWS::CloudFront::Distribution'));
      expect(JSON.stringify(dist)).not.toContain('CustomErrorResponses');
    });

    it('spaFallback devuelve /index.html con 200 en 403 y 404', () => {
      synthWith({ spaFallback: true }).hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          CustomErrorResponses: [
            {
              ErrorCode: 403,
              ResponseCode: 200,
              ResponsePagePath: '/index.html',
              ErrorCachingMinTTL: 10,
            },
            {
              ErrorCode: 404,
              ResponseCode: 200,
              ResponsePagePath: '/index.html',
              ErrorCachingMinTTL: 10,
            },
          ],
        }),
      });
    });

    it('responseHeaders crea una política con CSP y noindex', () => {
      const template = synthWith({
        responseHeaders: { contentSecurityPolicy: "default-src 'self'", noIndex: true },
      });
      template.resourceCountIs('AWS::CloudFront::ResponseHeadersPolicy', 1);
      template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
        ResponseHeadersPolicyConfig: Match.objectLike({
          SecurityHeadersConfig: Match.objectLike({
            ContentSecurityPolicy: { ContentSecurityPolicy: "default-src 'self'", Override: true },
          }),
          CustomHeadersConfig: {
            Items: [{ Header: 'X-Robots-Tag', Value: 'noindex, nofollow', Override: true }],
          },
        }),
      });
    });

    it('sin noIndex no agrega X-Robots-Tag', () => {
      const template = synthWith({
        responseHeaders: { contentSecurityPolicy: "default-src 'self'" },
      });
      const [policy] = Object.values(
        template.findResources('AWS::CloudFront::ResponseHeadersPolicy'),
      );
      expect(JSON.stringify(policy)).not.toContain('X-Robots-Tag');
    });

    it('responseHeaders.disabled (Floci) vuelve a la política administrada', () => {
      const template = synthWith({
        responseHeaders: {
          contentSecurityPolicy: "default-src 'self'",
          noIndex: true,
          disabled: true,
        },
      });
      template.resourceCountIs('AWS::CloudFront::ResponseHeadersPolicy', 0);
    });
  });
});
