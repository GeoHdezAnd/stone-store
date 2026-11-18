import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
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
    // Con Floci se apaga el autodelete (límite del emulador, ver `StaticSite`).
    this.site = new StaticSite(this, 'Site', {
      ephemeral: deploy.name === 'dev',
      autoDeleteObjects: !deploy.emulated,
    });

    // Salidas con nombre lógico fijo: `scripts/sync-site.ts` las lee para saber a qué
    // bucket subir y qué distribución invalidar. No cambiar estos ids sin ajustar el script.
    new CfnOutput(this, 'BucketName', { value: this.site.bucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: this.site.distribution.distributionId });
    new CfnOutput(this, 'DistributionDomainName', {
      value: this.site.distribution.domainName,
    });
  }
}
