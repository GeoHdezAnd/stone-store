import { App, Tags } from 'aws-cdk-lib';
import { AdminSiteStack } from '../lib/admin-site-stack.js';
import { ApiStack } from '../lib/api-stack.js';
import { AuthStack } from '../lib/auth-stack.js';
import { CiStack } from '../lib/ci-stack.js';
import { resolveEnv } from '../lib/config.js';
import { DataStack } from '../lib/data-stack.js';
import { MediaStack } from '../lib/media-stack.js';
import { PublishStack } from '../lib/publish-stack.js';
import { validateAllowedOrigins } from '../lib/origins.js';
import { SiteStack } from '../lib/site-stack.js';

const deploy = resolveEnv();
const app = new App();

// Entorno fijo (cuenta y región validadas por resolveEnv). Si no hay cuenta (dev sin
// emulador ni credenciales), el stack queda agnóstico de cuenta.
const env = deploy.account
  ? { account: deploy.account, region: deploy.region }
  : { region: deploy.region };

new SiteStack(app, `canteras-site-${deploy.name}`, { env, deploy });
new AdminSiteStack(app, `canteras-admin-site-${deploy.name}`, { env, deploy });
const data = new DataStack(app, `canteras-data-${deploy.name}`, { env, deploy });

const auth = new AuthStack(app, `canteras-auth-${deploy.name}`, { env, deploy });

// Orígenes CORS del dashboard: lista separada por comas en ADMIN_ORIGINS. En prod es
// obligatoria (falla si falta); en dev, sin la variable, se usa http://localhost:5173.
// Se validan UNA vez y se pasan a la API y al bucket de media (mismos orígenes en ambos).
const adminOrigins = (process.env['ADMIN_ORIGINS'] ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter((o) => o !== '');
const allowedOrigins = validateAllowedOrigins(
  deploy,
  adminOrigins.length > 0 ? adminOrigins : undefined,
);

// Orígenes CORS del SITIO PÚBLICO (lista separada por comas en SITE_ORIGINS): se unen a los del
// dashboard SOLO en la API (el bucket de media no los recibe). En dev, sin la variable, se usa
// http://localhost:4321 (Astro); en prod pueden faltar, pero si se pasan deben ser https.
const siteOrigins = (process.env['SITE_ORIGINS'] ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter((o) => o !== '');

// URL del dashboard para el enlace del aviso al dueño (opcional). Se valida en ApiStack.
const adminBaseUrl = (process.env['ADMIN_BASE_URL'] ?? '').trim();

// Nombre del parámetro SSM (SecureString) con el secreto de Turnstile (opcional). El dueño lo crea a
// mano en AWS real ANTES de `cdk diff/deploy`: `aws ssm put-parameter --type SecureString ...`. Sin él,
// `POST /quotes` falla cerrado (503 `captcha_not_configured`). Con emulador se ignora.
const turnstileSecretParam = (process.env['TURNSTILE_SECRET_PARAM'] ?? '').trim();

// Fotos del catálogo: bucket privado al que el dashboard sube con URL prefirmada.
const media = new MediaStack(app, `canteras-media-${deploy.name}`, {
  env,
  deploy,
  allowedOrigins,
});

// Catálogo publicado (`catalog.json`): bucket privado y versionado, distinto del del sitio.
const publish = new PublishStack(app, `canteras-publish-${deploy.name}`, { env, deploy });

// Id de la distribución de CloudFront del sitio (salida `DistributionId` de `canteras-site-<env>`).
// Opcional: sin él, publicar no invalida CloudFront y la Lambda no recibe ese permiso. Se pasa
// por entorno para no crear una dependencia ApiStack -> SiteStack.
const siteDistributionId = (process.env['SITE_DISTRIBUTION_ID'] ?? '').trim();
if (siteDistributionId !== '' && !/^[A-Z0-9]{8,20}$/.test(siteDistributionId)) {
  throw new Error(
    'SITE_DISTRIBUTION_ID no tiene el formato de un id de distribución de CloudFront.',
  );
}

// Identidad verificada de SES desde la que se envían las cotizaciones (opcional). Sin ella, y fuera
// del emulador, enviar cotizaciones responde 409 `mail_not_configured`. El formato se valida en ApiStack.
const sesIdentityArn = (process.env['SES_IDENTITY_ARN'] ?? '').trim();

// Identidades SES de destinatarios (lista separada por comas, opcional; ver la prop en ApiStack).
const sesRecipientIdentityArns = (process.env['SES_RECIPIENT_IDENTITY_ARNS'] ?? '')
  .split(',')
  .map((a) => a.trim())
  .filter((a) => a !== '');

new ApiStack(app, `canteras-api-${deploy.name}`, {
  env,
  deploy,
  ...(sesIdentityArn === '' ? {} : { sesIdentityArn }),
  ...(sesRecipientIdentityArns.length === 0 ? {} : { sesRecipientIdentityArns }),
  userPool: auth.userPool,
  userPoolClient: auth.userPoolClient,
  mediaBucket: media.bucket,
  publishBucket: publish.bucket,
  ...(siteDistributionId === '' ? {} : { siteDistributionId }),
  ...(siteOrigins.length === 0 ? {} : { siteOrigins }),
  ...(adminBaseUrl === '' ? {} : { adminBaseUrl }),
  ...(turnstileSecretParam === '' ? {} : { turnstileSecretParam }),
  tables: {
    stones: data.stones,
    projects: data.projects,
    finishes: data.finishes,
    services: data.services,
    settings: data.settings,
    auditLog: data.auditLog,
    publications: data.publications,
    freightConfig: data.freightConfig,
    quotes: data.quotes,
    counters: data.counters,
    ...(data.mailOutbox ? { mailOutbox: data.mailOutbox } : {}),
  },
  allowedOrigins,
});

// Identidad de CI/CD (OIDC de GitHub). Los IDs numéricos salen de `gh api repos/<dueño>/<repo>`.
// AWS permite un solo proveedor OIDC de GitHub por cuenta: si más adelante hay un CiStack de
// `prod` en la misma cuenta, pásale `existingOidcProviderArn` para no crear un segundo proveedor.
new CiStack(app, `canteras-ci-${deploy.name}`, {
  env,
  deploy,
  github: {
    owner: 'GeoHdezAnd',
    ownerId: '154252360',
    repo: 'stone-store',
    repoId: '1461883588',
  },
});

// Convención de etiquetas (CLAUDE.md 9.1): se aplican a todos los stacks.
Tags.of(app).add('Project', 'canteras-naturales');
Tags.of(app).add('Env', deploy.name);

app.synth();
