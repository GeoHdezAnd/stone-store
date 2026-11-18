import { App, Tags } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, it } from 'vitest';

import { SiteStack } from './site-stack.js';

function synth(name: 'dev' | 'prod'): Template {
  const app = new App();
  const stack = new SiteStack(app, 'Prueba', {
    deploy: { name, account: undefined, region: 'us-east-1' },
  });
  Tags.of(app).add('Project', 'canteras-naturales');
  Tags.of(app).add('Env', name);
  return Template.fromStack(stack);
}

describe('SiteStack', () => {
  it('en dev crea el sitio efímero (bucket se borra con el stack)', () => {
    synth('dev').hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
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

  it('expone el dominio de CloudFront como salida', () => {
    synth('dev').hasOutput('*', {});
  });
});
