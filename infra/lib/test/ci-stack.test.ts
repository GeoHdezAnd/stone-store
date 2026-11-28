import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { CiStack, type CiStackProps } from '../ci-stack.js';

const ACCOUNT = '123456789012';
const GITHUB = {
  owner: 'GeoHdezAnd',
  ownerId: '154252360',
  repo: 'stone-store',
  repoId: '1461883588',
};

function synth(overrides: Partial<CiStackProps> = {}, name: 'dev' | 'prod' = 'dev'): Template {
  const stack = new CiStack(new App(), 'Prueba', {
    env: { account: ACCOUNT, region: 'us-east-1' },
    deploy: { name, account: ACCOUNT, region: 'us-east-1', emulated: false },
    github: GITHUB,
    ...overrides,
  });
  return Template.fromStack(stack);
}

interface Statement {
  Effect: string;
  Action: string | string[];
  Resource?: unknown;
  Condition?: Record<string, Record<string, unknown>>;
}

/** Todas las sentencias de las políticas del rol de despliegue, aplanadas. */
function permissionStatements(template: Template): Statement[] {
  const policies = Object.values(template.findResources('AWS::IAM::Policy'));
  return policies.flatMap((p) => {
    const doc = (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties
      .PolicyDocument;
    return doc.Statement;
  });
}

const actionsOf = (s: Statement): string[] => (Array.isArray(s.Action) ? s.Action : [s.Action]);
const resourcesOf = (s: Statement): unknown[] =>
  Array.isArray(s.Resource) ? s.Resource : [s.Resource];

describe('CiStack', () => {
  describe('proveedor OIDC de GitHub', () => {
    it('lo crea con la URL de GitHub y el público sts.amazonaws.com', () => {
      synth().hasResourceProperties('AWS::IAM::OIDCProvider', {
        Url: 'https://token.actions.githubusercontent.com',
        ClientIdList: ['sts.amazonaws.com'],
      });
    });

    it('no usa Lambdas ni custom resources (el constructo L2 las crea y no hacen falta)', () => {
      const template = synth();
      template.resourceCountIs('AWS::Lambda::Function', 0);
      template.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 0);
    });

    it('con un proveedor existente no crea otro y lo usa en la confianza', () => {
      const arn = `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`;
      const template = synth({ existingOidcProviderArn: arn });
      template.resourceCountIs('AWS::IAM::OIDCProvider', 0);
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [Match.objectLike({ Principal: { Federated: arn } })],
        },
      });
    });
  });

  describe('política de confianza del rol', () => {
    it('solo permite AssumeRoleWithWebIdentity, con una única sentencia', () => {
      synth().hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [
            Match.objectLike({ Effect: 'Allow', Action: 'sts:AssumeRoleWithWebIdentity' }),
          ],
        },
      });
    });

    it('exige el sub inmutable exacto del environment (con IDs numéricos) y aud', () => {
      synth().hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [
            Match.objectLike({
              Condition: {
                StringEquals: {
                  'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                  'token.actions.githubusercontent.com:sub':
                    'repo:GeoHdezAnd@154252360/stone-store@1461883588:environment:dev',
                },
              },
            }),
          ],
        },
      });
    });

    it('sigue el nombre del entorno en el sub (prod → environment:prod)', () => {
      synth({}, 'prod').hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [
            Match.objectLike({
              Condition: {
                StringEquals: Match.objectLike({
                  'token.actions.githubusercontent.com:sub':
                    'repo:GeoHdezAnd@154252360/stone-store@1461883588:environment:prod',
                }),
              },
            }),
          ],
        },
      });
    });

    it('no usa comodines ni operadores laxos en las condiciones', () => {
      const roles = Object.values(synth().findResources('AWS::IAM::Role'));
      const trust = JSON.stringify(
        (roles[0] as { Properties: { AssumeRolePolicyDocument: unknown } }).Properties
          .AssumeRolePolicyDocument,
      );
      expect(trust).not.toMatch(/StringLike/);
      expect(trust).not.toMatch(/ForAllValues|ForAnyValue/);
      expect(trust).not.toMatch(/\*/);
    });

    it.each([
      ['owner', { owner: 'Geo*' }],
      ['ownerId', { ownerId: '154252360:*' }],
      ['repo', { repo: 'stone-store/../otro' }],
      ['repoId', { repoId: '' }],
    ])('rechaza un %s inválido en la configuración de GitHub', (_campo, parcial) => {
      expect(() => synth({ github: { ...GITHUB, ...parcial } })).toThrow(/GitHub/);
    });
  });

  describe('permisos del rol (mínimo privilegio)', () => {
    it('crea exactamente un rol, de una hora de sesión', () => {
      const template = synth();
      template.resourceCountIs('AWS::IAM::Role', 1);
      template.hasResourceProperties('AWS::IAM::Role', { MaxSessionDuration: 3600 });
    });

    it('ninguna sentencia usa Resource "*" ni acciones con comodín de servicio', () => {
      const statements = permissionStatements(synth());
      // Sin esta guarda el bucle no comprobaría nada si el rol se quedara sin permisos.
      expect(statements.length).toBeGreaterThan(0);
      for (const s of statements) {
        expect(resourcesOf(s)).not.toContain('*');
        for (const action of actionsOf(s)) {
          expect(action).not.toMatch(/^\*$|^[a-z0-9-]+:\*$/);
        }
      }
    });

    it('solo puede asumir los roles de bootstrap de CDK (deploy, file-publishing, lookup)', () => {
      const assume = permissionStatements(synth()).filter((s) =>
        actionsOf(s).includes('sts:AssumeRole'),
      );
      expect(assume).toHaveLength(1);
      expect(assume[0]?.Resource).toEqual([
        `arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-deploy-role-${ACCOUNT}-us-east-1`,
        `arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-file-publishing-role-${ACCOUNT}-us-east-1`,
        `arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-lookup-role-${ACCOUNT}-us-east-1`,
      ]);
    });

    it('limita S3 al bucket del sitio del entorno, con solo las acciones de `sync`', () => {
      const s3 = permissionStatements(synth()).filter((s) =>
        actionsOf(s).some((a) => a.startsWith('s3:')),
      );
      const actions = s3.flatMap(actionsOf).sort();
      expect(actions).toEqual(['s3:DeleteObject', 's3:ListBucket', 's3:PutObject']);
      const resources = s3.flatMap(resourcesOf).map(String);
      expect(resources.length).toBeGreaterThan(0);
      for (const r of resources) {
        expect(r).toMatch(/^arn:aws:s3:::canteras-site-dev-sitebucket\*(\/\*)?$/);
      }
    });

    it('el bucket autorizado cambia con el entorno (prod → canteras-site-prod-…)', () => {
      const s3 = permissionStatements(synth({}, 'prod')).filter((s) =>
        actionsOf(s).some((a) => a.startsWith('s3:')),
      );
      const resources = s3.flatMap(resourcesOf).map(String);
      expect(resources.length).toBeGreaterThan(0);
      for (const r of resources) {
        expect(r).toContain('canteras-site-prod-sitebucket');
      }
    });

    it('CloudFront: solo CreateInvalidation, dentro de la cuenta', () => {
      const cf = permissionStatements(synth()).filter((s) =>
        actionsOf(s).some((a) => a.startsWith('cloudfront:')),
      );
      expect(cf).toHaveLength(1);
      expect(cf[0]?.Action).toEqual('cloudfront:CreateInvalidation');
      expect(cf[0]?.Resource).toEqual(`arn:aws:cloudfront::${ACCOUNT}:distribution/*`);
    });

    it('CloudFormation: solo DescribeStacks del stack del sitio del entorno', () => {
      const cfn = permissionStatements(synth()).filter((s) =>
        actionsOf(s).some((a) => a.startsWith('cloudformation:')),
      );
      expect(cfn).toHaveLength(1);
      expect(cfn[0]?.Action).toEqual('cloudformation:DescribeStacks');
      expect(cfn[0]?.Resource).toEqual(
        `arn:aws:cloudformation:us-east-1:${ACCOUNT}:stack/canteras-site-dev/*`,
      );
    });

    it('no concede permisos de IAM ni de escritura fuera de lo anterior', () => {
      const servicios = new Set(
        permissionStatements(synth())
          .flatMap(actionsOf)
          .map((a) => a.split(':')[0]),
      );
      expect([...servicios].sort()).toEqual(['cloudformation', 'cloudfront', 's3', 'sts']);
    });
  });

  it('expone el ARN del rol como salida (para la variable del repo)', () => {
    const template = synth();
    // La salida debe apuntar al ARN del rol creado, no a un valor cualquiera.
    template.hasOutput('DeployRoleArn', {
      Value: { 'Fn::GetAtt': [Match.stringLikeRegexp('^DeployRole'), 'Arn'] },
    });
    expect(Object.keys(template.findResources('AWS::IAM::Role'))[0]).toMatch(/^DeployRole/);
  });
});

describe('CiStack: SiteRebuildRole (reconstrucción del sitio al publicar)', () => {
  const DIST = 'E1ABCDEF234567';
  const OIDC = 'token.actions.githubusercontent.com';

  const rolesDe = (t: Template, prefijo: string) =>
    Object.entries(t.findResources('AWS::IAM::Role')).filter(([id]) => id.startsWith(prefijo));

  /** Sentencias de las políticas adjuntas SOLO al rol de reconstrucción. */
  function sentenciasRebuild(t: Template): Statement[] {
    const [rolId] = rolesDe(t, 'SiteRebuildRole')[0]!;
    return Object.values(t.findResources('AWS::IAM::Policy'))
      .filter((p) =>
        ((p as { Properties: { Roles: { Ref: string }[] } }).Properties.Roles ?? []).some(
          (r) => r.Ref === rolId,
        ),
      )
      .flatMap(
        (p) =>
          (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties
            .PolicyDocument.Statement,
      );
  }

  it('sin SITE_DISTRIBUTION_ID NO se crea el rol ni su salida (falla cerrado)', () => {
    for (const siteDistributionId of [undefined, '']) {
      const t = synth(siteDistributionId === undefined ? {} : { siteDistributionId });
      expect(rolesDe(t, 'SiteRebuildRole')).toHaveLength(0);
      t.resourceCountIs('AWS::IAM::Role', 1);
      expect(Object.keys(t.toJSON().Outputs ?? {})).not.toContain('SiteRebuildRoleArn');
    }
  });

  it('con la distribución: crea un segundo rol de una hora y la salida SiteRebuildRoleArn', () => {
    const t = synth({ siteDistributionId: DIST });
    t.resourceCountIs('AWS::IAM::Role', 2);
    expect(rolesDe(t, 'SiteRebuildRole')).toHaveLength(1);
    expect(rolesDe(t, 'DeployRole')).toHaveLength(1);
    t.hasResourceProperties('AWS::IAM::Role', {
      MaxSessionDuration: 3600,
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: [
          Match.objectLike({
            Principal: Match.anyValue(),
            Condition: Match.objectLike({
              StringEquals: Match.objectLike({
                [`${OIDC}:sub`]: Match.stringLikeRegexp('site-rebuild'),
              }),
            }),
          }),
        ],
      }),
    });
    t.hasOutput('SiteRebuildRoleArn', {
      Value: { 'Fn::GetAtt': [Match.stringLikeRegexp('^SiteRebuildRole'), 'Arn'] },
    });
  });

  it('la confianza exige EXACTAMENTE aud, sub (environment site-rebuild-dev), repository_id y ref', () => {
    const t = synth({ siteDistributionId: DIST });
    const [, rol] = rolesDe(t, 'SiteRebuildRole')[0]!;
    const trust = (rol as { Properties: { AssumeRolePolicyDocument: { Statement: Statement[] } } })
      .Properties.AssumeRolePolicyDocument;
    expect(trust.Statement).toHaveLength(1);
    expect(trust.Statement[0]!.Action).toBe('sts:AssumeRoleWithWebIdentity');
    expect(trust.Statement[0]!.Condition).toEqual({
      StringEquals: {
        [`${OIDC}:aud`]: 'sts.amazonaws.com',
        [`${OIDC}:sub`]:
          'repo:GeoHdezAnd@154252360/stone-store@1461883588:environment:site-rebuild-dev',
        [`${OIDC}:repository_id`]: '1461883588',
        [`${OIDC}:ref`]: 'refs/heads/main',
      },
    });
    expect(JSON.stringify(trust)).not.toMatch(/StringLike|\*/);
  });

  it('sigue el entorno en el sub (prod → environment:site-rebuild-prod)', () => {
    const t = synth({ siteDistributionId: DIST }, 'prod');
    const [, rol] = rolesDe(t, 'SiteRebuildRole')[0]!;
    expect(JSON.stringify(rol)).toContain(
      'repo:GeoHdezAnd@154252360/stone-store@1461883588:environment:site-rebuild-prod',
    );
  });

  it('el rol de despliegue NO cambia: su environment sigue siendo el del entorno', () => {
    const t = synth({ siteDistributionId: DIST });
    const [, rol] = rolesDe(t, 'DeployRole')[0]!;
    const texto = JSON.stringify(rol);
    expect(texto).toContain('1461883588:environment:dev"');
    expect(texto).not.toContain('site-rebuild');
    expect(texto).not.toContain('repository_id');
  });

  it('política EXACTA: DescribeStacks, ListBucket, Put/Delete y CreateInvalidation sobre ESA distribución', () => {
    const ss = sentenciasRebuild(synth({ siteDistributionId: DIST }));
    const porAccion = (a: string) => ss.filter((s) => actionsOf(s).includes(a));
    expect(ss).toHaveLength(4);
    expect(ss.every((s) => s.Effect === 'Allow')).toBe(true);
    expect(porAccion('cloudformation:DescribeStacks')[0]?.Resource).toEqual(
      `arn:aws:cloudformation:us-east-1:${ACCOUNT}:stack/canteras-site-dev/*`,
    );
    expect(porAccion('s3:ListBucket')[0]?.Resource).toEqual(
      'arn:aws:s3:::canteras-site-dev-sitebucket*',
    );
    const escritura = porAccion('s3:PutObject')[0]!;
    expect(actionsOf(escritura).sort()).toEqual(['s3:DeleteObject', 's3:PutObject']);
    expect(escritura.Resource).toEqual('arn:aws:s3:::canteras-site-dev-sitebucket*/*');
    expect(porAccion('cloudfront:CreateInvalidation')[0]?.Resource).toEqual(
      `arn:aws:cloudfront::${ACCOUNT}:distribution/${DIST}`,
    );
  });

  it('no usa comodín de distribución, ni de cuenta, ni acciones con comodín', () => {
    const ss = sentenciasRebuild(synth({ siteDistributionId: DIST }));
    const texto = JSON.stringify(ss);
    expect(texto).not.toContain('distribution/*');
    for (const s of ss) {
      expect(resourcesOf(s)).not.toContain('*');
      for (const a of actionsOf(s)) expect(a).not.toMatch(/\*/);
    }
    expect(new Set(ss.flatMap(actionsOf).map((a) => a.split(':')[0])).size).toBe(3);
    expect(texto).not.toMatch(/sts:|iam:|ssm:|kms:/);
  });

  it('un id de distribución con formato inválido lanza', () => {
    for (const siteDistributionId of ['*', 'e1abcdef', 'E1/..', 'distribution/*']) {
      expect(() => synth({ siteDistributionId })).toThrow(/distribución/i);
    }
  });
});
