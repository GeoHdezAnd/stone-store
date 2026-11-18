import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import {
  AccountRecovery,
  ClientAttributes,
  CfnUserPoolGroup,
  Mfa,
  UserPool,
  UserPoolClient,
} from 'aws-cdk-lib/aws-cognito';
import { ROLES } from '@canteras/shared';
import { type Construct } from 'constructs';

import { type DeployEnv } from './config.js';

export interface AuthStackProps extends StackProps {
  readonly deploy: DeployEnv;
}

/**
 * Autenticación del dashboard con Amazon Cognito (User Pool: directorio de usuarios con
 * login, contraseñas y MFA administrado por AWS; ~gratis hasta 10,000 usuarios activos al mes).
 *
 * Seguridad (CLAUDE.md 10): sin auto-registro, contraseña de 12+ caracteres, MFA TOTP opcional
 * (pasa a obligatorio para `owner` cuando el SPA tenga el flujo de alta de TOTP), sesiones cortas.
 */
export class AuthStack extends Stack {
  public readonly userPool: UserPool;
  public readonly userPoolClient: UserPoolClient;

  public constructor(scope: Construct, id: string, props: AuthStackProps) {
    const { deploy, ...stackProps } = props;
    super(scope, id, stackProps);

    const isProd = deploy.name === 'prod';

    this.userPool = new UserPool(this, 'UserPool', {
      // Solo el administrador (o la invitación del dashboard) crea usuarios.
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      // El correo es el username: «Ana@x.mx» y «ana@x.mx» son la MISMA cuenta. Solo se puede
      // fijar al CREAR el pool; cambiarlo después obliga a recrearlo (y perder sus usuarios).
      signInCaseSensitive: false,
      // Un cambio de correo exige verificar el nuevo y conserva el original mientras tanto.
      keepOriginal: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 12,
        requireUppercase: true,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      // Sin SMS: cuesta dinero y es el factor más débil.
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      mfa: Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      // dev se borra con el stack; prod se conserva y no se puede borrar por accidente.
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      deletionProtection: isProd,
    });

    this.userPoolClient = this.userPool.addClient('AdminClient', {
      // SPA pública: no puede guardar un secreto.
      generateSecret: false,
      // El SPA no edita atributos. Sin esto el cliente puede escribir TODOS los atributos
      // modificables: con un access token se cambiaría el correo (el username) y se tomaría
      // otra cuenta. Lista vacía = ninguno.
      writeAttributes: new ClientAttributes(),
      authFlows: {
        userSrp: true,
        // USER_PASSWORD_AUTH manda la contraseña en claro al servicio: solo en el emulador,
        // para pruebas con curl (scripts/dev-token.ts). En AWS real queda apagado.
        userPassword: deploy.emulated,
      },
      // Sin hosted UI ni OAuth: el SPA usa SRP directo contra Cognito.
      disableOAuth: true,
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      // «Sesiones cortas» (CLAUDE.md 10): tokens de 1 h y refresh de 8 h (una jornada).
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.hours(8),
    });

    // Los nombres de grupo son EXACTAMENTE los valores de ROLES (sin espacios): la
    // autorización compara el nombre exacto (ver packages/shared/src/auth/groups.ts).
    for (const role of ROLES) {
      new CfnUserPoolGroup(this, `Group-${role}`, {
        userPoolId: this.userPool.userPoolId,
        groupName: role,
      });
    }

    // Ids fijos: los scripts de desarrollo (scripts/dev-*.ts) los leen. No cambiar sin ajustarlos.
    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
  }
}
