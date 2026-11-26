import { App, Tags } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ROLES } from '@canteras/shared';
import { describe, expect, it } from 'vitest';

import { AuthStack } from '../auth-stack.js';

function build(name: 'dev' | 'prod', emulated = false): { template: Template; stack: AuthStack } {
  const app = new App();
  const stack = new AuthStack(app, 'Prueba', {
    deploy: { name, account: undefined, region: 'us-east-1', emulated },
  });
  Tags.of(app).add('Project', 'canteras-naturales');
  Tags.of(app).add('Env', name);
  return { template: Template.fromStack(stack), stack };
}
const synth = (name: 'dev' | 'prod', emulated = false): Template => build(name, emulated).template;

describe('AuthStack: User Pool', () => {
  it('crea exactamente un User Pool', () => {
    synth('dev').resourceCountIs('AWS::Cognito::UserPool', 1);
  });

  it('no permite auto-registro (solo el administrador crea usuarios)', () => {
    synth('dev').hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
  });

  it('inicia sesión con correo', () => {
    synth('dev').hasResourceProperties('AWS::Cognito::UserPool', {
      UsernameAttributes: ['email'],
    });
  });

  it('exige contraseñas de 12 caracteres con mayúscula, minúscula, número y símbolo', () => {
    synth('dev').hasResourceProperties('AWS::Cognito::UserPool', {
      Policies: {
        PasswordPolicy: Match.objectLike({
          MinimumLength: 12,
          RequireUppercase: true,
          RequireLowercase: true,
          RequireNumbers: true,
          RequireSymbols: true,
        }),
      },
    });
  });

  it('recupera la cuenta solo por correo', () => {
    synth('dev').hasResourceProperties('AWS::Cognito::UserPool', {
      AccountRecoverySetting: {
        RecoveryMechanisms: [{ Name: 'verified_email', Priority: 1 }],
      },
    });
  });

  it('en AWS real el MFA es obligatorio con TOTP y sin SMS (dev y prod)', () => {
    for (const name of ['dev', 'prod'] as const) {
      const t = synth(name, false);
      t.hasResourceProperties('AWS::Cognito::UserPool', {
        MfaConfiguration: 'ON',
        EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
      });
      const pool = Object.values(t.findResources('AWS::Cognito::UserPool'))[0]!;
      expect(JSON.stringify(pool.Properties)).not.toContain('SMS_MFA');
    }
  });

  it('con emulador el MFA es opcional (TOTP, sin SMS) para que sigan los scripts de desarrollo', () => {
    const t = synth('dev', true);
    t.hasResourceProperties('AWS::Cognito::UserPool', {
      MfaConfiguration: 'OPTIONAL',
      EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
    });
    const pool = Object.values(t.findResources('AWS::Cognito::UserPool'))[0]!;
    expect(JSON.stringify(pool.Properties)).not.toContain('SMS_MFA');
  });

  it('en dev se borra con el stack y sin protección contra borrado', () => {
    const t = synth('dev');
    t.hasResource('AWS::Cognito::UserPool', {
      DeletionPolicy: 'Delete',
      UpdateReplacePolicy: 'Delete',
    });
    t.hasResourceProperties('AWS::Cognito::UserPool', { DeletionProtection: 'INACTIVE' });
  });

  it('en prod se conserva y tiene protección contra borrado', () => {
    const t = synth('prod');
    t.hasResource('AWS::Cognito::UserPool', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
    t.hasResourceProperties('AWS::Cognito::UserPool', { DeletionProtection: 'ACTIVE' });
  });
});

describe('AuthStack: protección contra toma de cuenta y correos', () => {
  it('el cliente NO puede escribir atributos (WriteAttributes vacío y explícito)', () => {
    const client = Object.values(synth('dev').findResources('AWS::Cognito::UserPoolClient'))[0]!;
    // Ausente significaría «todos los atributos escribibles»: con un access token se podría
    // cambiar el correo (que es el username) y tomar otra cuenta.
    expect(client.Properties.WriteAttributes).toEqual([]);
  });

  it('cambiar el correo exige verificarlo primero y conserva el original mientras tanto', () => {
    synth('dev').hasResourceProperties('AWS::Cognito::UserPool', {
      UserAttributeUpdateSettings: { AttributesRequireVerificationBeforeUpdate: ['email'] },
    });
  });

  it('el inicio de sesión no distingue mayúsculas (solo se puede fijar al crear el pool)', () => {
    synth('dev').hasResourceProperties('AWS::Cognito::UserPool', {
      UsernameConfiguration: { CaseSensitive: false },
    });
  });
});

describe('AuthStack: cliente de la SPA', () => {
  it('crea un solo cliente sin secreto (es una SPA pública)', () => {
    const t = synth('dev');
    t.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', { GenerateSecret: false });
  });

  it('en AWS real solo permite SRP (sin USER_PASSWORD_AUTH)', () => {
    for (const name of ['dev', 'prod'] as const) {
      synth(name, false).hasResourceProperties('AWS::Cognito::UserPoolClient', {
        ExplicitAuthFlows: ['ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      });
    }
  });

  it('con emulador habilita USER_PASSWORD_AUTH para pruebas con curl', () => {
    synth('dev', true).hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ExplicitAuthFlows: Match.arrayWith(['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_USER_SRP_AUTH']),
    });
  });

  it('el reto de MFA dura 15 minutos (el máximo) en AWS real y con emulador', () => {
    // El default de Cognito son 3 min: se vence mientras el dueño instala la app autenticadora.
    for (const emulated of [false, true]) {
      synth('dev', emulated).hasResourceProperties('AWS::Cognito::UserPoolClient', {
        AuthSessionValidity: 15,
      });
    }
    synth('prod', false).hasResourceProperties('AWS::Cognito::UserPoolClient', {
      AuthSessionValidity: 15,
    });
  });

  it('oculta si el usuario existe y revoca tokens', () => {
    synth('dev').hasResourceProperties('AWS::Cognito::UserPoolClient', {
      PreventUserExistenceErrors: 'ENABLED',
      EnableTokenRevocation: true,
    });
  });

  it('no usa OAuth ni hosted UI', () => {
    const t = synth('dev');
    const client = Object.values(t.findResources('AWS::Cognito::UserPoolClient'))[0]!;
    expect(client.Properties.AllowedOAuthFlows).toBeUndefined();
    expect(client.Properties.CallbackURLs).toBeUndefined();
    t.resourceCountIs('AWS::Cognito::UserPoolDomain', 0);
  });

  it('sesiones cortas: tokens de 1 hora y refresh de 8 horas', () => {
    synth('dev').hasResourceProperties('AWS::Cognito::UserPoolClient', {
      AccessTokenValidity: 60,
      IdTokenValidity: 60,
      RefreshTokenValidity: 480,
      TokenValidityUnits: { AccessToken: 'minutes', IdToken: 'minutes', RefreshToken: 'minutes' },
    });
  });
});

describe('AuthStack: grupos', () => {
  it('los nombres coinciden exactamente con ROLES de shared y no llevan espacios', () => {
    expect([...ROLES]).toEqual(['owner', 'staff']);
    const grupos = Object.values(synth('dev').findResources('AWS::Cognito::UserPoolGroup')).map(
      (g) => g.Properties.GroupName as string,
    );
    expect(grupos.sort()).toEqual([...ROLES].sort());
    for (const g of grupos) expect(g).not.toMatch(/\s/);
  });
});

describe('AuthStack: salidas y recursos', () => {
  it('exporta UserPoolId y UserPoolClientId', () => {
    const t = synth('dev');
    t.hasOutput('UserPoolId', { Value: Match.anyValue() });
    t.hasOutput('UserPoolClientId', { Value: Match.anyValue() });
  });

  it('no usa custom resources (no funcionan en Floci)', () => {
    const t = synth('dev', true);
    const tipos = Object.values(t.toJSON().Resources as Record<string, { Type: string }>).map(
      (r) => r.Type,
    );
    expect(
      tipos.filter((x) => x.startsWith('Custom::') || x === 'AWS::CloudFormation::CustomResource'),
    ).toEqual([]);
  });

  it('etiqueta con Project y Env', () => {
    synth('dev').hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolTags: Match.objectLike({ Env: 'dev', Project: 'canteras-naturales' }),
    });
  });
});
