import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import { CfnOIDCProvider, FederatedPrincipal, PolicyStatement, Role } from 'aws-cdk-lib/aws-iam';
import { type Construct } from 'constructs';

import { type DeployEnv } from './config.js';

/** Calificador del bootstrap por defecto de CDK (aparece en los nombres `cdk-<calificador>-…`). */
export const BOOTSTRAP_QUALIFIER = 'hnb659fds';

const OIDC_HOST = 'token.actions.githubusercontent.com';

export interface GithubRepo {
  /** Dueño del repositorio (usuario u organización). */
  readonly owner: string;
  /** ID numérico del dueño: GitHub lo incluye en el `sub` de los repos creados desde el 15-jul-2026. */
  readonly ownerId: string;
  readonly repo: string;
  /** ID numérico del repositorio. */
  readonly repoId: string;
}

export interface CiStackProps extends StackProps {
  readonly deploy: DeployEnv;
  readonly github: GithubRepo;
  /**
   * ARN de un proveedor OIDC de GitHub que ya exista en la cuenta. AWS solo permite uno por URL
   * y cuenta: si ya hay uno, se reutiliza en lugar de crear otro.
   */
  readonly existingOidcProviderArn?: string;
}

// Se validan los datos de GitHub porque terminan dentro de la política de confianza: un
// comodín o un valor vacío aquí abriría el rol a repositorios que no son el nuestro.
function assertGithubRepo(github: GithubRepo): void {
  const checks: [string, string, RegExp][] = [
    ['owner', github.owner, /^[A-Za-z0-9-]+$/],
    ['ownerId', github.ownerId, /^\d+$/],
    ['repo', github.repo, /^[A-Za-z0-9._-]+$/],
    ['repoId', github.repoId, /^\d+$/],
  ];
  for (const [campo, valor, patron] of checks) {
    if (!patron.test(valor)) {
      throw new Error(`Configuración de GitHub inválida: "${campo}" no es válido ("${valor}").`);
    }
  }
}

/**
 * Identidad de CI/CD: permite que GitHub Actions asuma un rol de AWS con OIDC, sin llaves largas.
 *
 * El rol solo confía en el `environment` del entorno (con aprobación manual en GitHub) de ESTE
 * repositorio, identificado por sus IDs numéricos. Sus permisos son mínimos: asumir los roles de
 * bootstrap de CDK y publicar el sitio (`scripts/sync-site.ts`).
 */
export class CiStack extends Stack {
  public readonly deployRole: Role;

  public constructor(scope: Construct, id: string, props: CiStackProps) {
    const { deploy, github, existingOidcProviderArn, ...stackProps } = props;
    super(scope, id, stackProps);
    assertGithubRepo(github);

    // Constructo L1 (CloudFormation nativo). El L2 `OpenIdConnectProvider` crea una Lambda
    // como custom resource que aquí no hace falta. La huella digital (thumbprint) ya no se necesita.
    const providerArn =
      existingOidcProviderArn ??
      new CfnOIDCProvider(this, 'GithubOidcProvider', {
        url: `https://${OIDC_HOST}`,
        clientIdList: ['sts.amazonaws.com'],
      }).ref;

    const sub = `repo:${github.owner}@${github.ownerId}/${github.repo}@${github.repoId}:environment:${deploy.name}`;

    this.deployRole = new Role(this, 'DeployRole', {
      description: `GitHub Actions (${deploy.name}): despliega el sitio de Canteras Naturales`,
      assumedBy: new FederatedPrincipal(
        providerArn,
        // StringEquals y no StringLike: el `sub` debe coincidir exacto, sin comodines.
        {
          StringEquals: {
            [`${OIDC_HOST}:aud`]: 'sts.amazonaws.com',
            [`${OIDC_HOST}:sub`]: sub,
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
      maxSessionDuration: Duration.hours(1),
    });

    const account = this.account;
    const region = this.region;
    const bucketPattern = `arn:aws:s3:::canteras-site-${deploy.name}-sitebucket*`;

    // cdk diff/deploy no actúan con este rol directamente: asumen los roles del bootstrap.
    this.deployRole.addToPolicy(
      new PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: ['deploy', 'file-publishing', 'lookup'].map(
          (kind) =>
            `arn:aws:iam::${account}:role/cdk-${BOOTSTRAP_QUALIFIER}-${kind}-role-${account}-${region}`,
        ),
      }),
    );

    // `sync-site.ts` lee las salidas del stack para saber qué bucket y distribución usar.
    this.deployRole.addToPolicy(
      new PolicyStatement({
        actions: ['cloudformation:DescribeStacks'],
        resources: [
          `arn:aws:cloudformation:${region}:${account}:stack/canteras-site-${deploy.name}/*`,
        ],
      }),
    );

    // Solo lo que usa `aws s3 sync --delete`: listar, subir y borrar en el bucket del sitio.
    this.deployRole.addToPolicy(
      new PolicyStatement({ actions: ['s3:ListBucket'], resources: [bucketPattern] }),
    );
    this.deployRole.addToPolicy(
      new PolicyStatement({
        actions: ['s3:PutObject', 's3:DeleteObject'],
        resources: [`${bucketPattern}/*`],
      }),
    );

    // El id de la distribución no se conoce al sintetizar este stack (es de otro): se acota a la cuenta.
    this.deployRole.addToPolicy(
      new PolicyStatement({
        actions: ['cloudfront:CreateInvalidation'],
        resources: [`arn:aws:cloudfront::${account}:distribution/*`],
      }),
    );

    // Valor para la variable del repositorio AWS_ROLE_ARN (no va en el código: el repo es público).
    new CfnOutput(this, 'DeployRoleArn', { value: this.deployRole.roleArn });
  }
}
