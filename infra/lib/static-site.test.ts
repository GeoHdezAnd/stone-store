import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, it } from 'vitest';

import { StaticSite } from './static-site.js';

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
});
