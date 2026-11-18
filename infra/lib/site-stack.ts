import { Stack, type StackProps } from 'aws-cdk-lib';
import { type Construct } from 'constructs';

import { type DeployEnv } from './config.js';
import { StaticSite } from './static-site.js';

export interface SiteStackProps extends StackProps {
  readonly deploy: DeployEnv;
}

/**
 * Sitio público: bucket privado + CloudFront. Sin dominio propio en la fase 1
 * (se usa el dominio `*.cloudfront.net`; Route 53 y ACM llegan cuando haya dominio).
 */
export class SiteStack extends Stack {
  public readonly site: StaticSite;

  public constructor(scope: Construct, id: string, props: SiteStackProps) {
    const { deploy, ...stackProps } = props;
    super(scope, id, stackProps);

    // Solo `dev` puede borrar el bucket junto con el stack (CLAUDE.md 9.2).
    this.site = new StaticSite(this, 'Site', { ephemeral: deploy.name === 'dev' });
  }
}
