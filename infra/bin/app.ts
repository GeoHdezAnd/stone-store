import { App, Tags } from 'aws-cdk-lib';
import { AdminSiteStack } from '../lib/admin-site-stack.js';
import { ApiStack } from '../lib/api-stack.js';
import { AuthStack } from '../lib/auth-stack.js';
import { parseSiteDistributionId } from '../lib/cdn-grant.js';
import { CiStack } from '../lib/ci-stack.js';
import { resolveEnv } from '../lib/config.js';
import { DataStack } from '../lib/data-stack.js';
import {
  MediaStack,
  RESERVED_CONCURRENCY_CONTEXT,
  parseReservedConcurrency,
} from '../lib/media-stack.js';
import {
  ALERT_EMAIL_ENV,
  ObservabilityStack,
  parseAlertEmail,
} from '../lib/observability-stack.js';
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

// ORDEN DE DESPLIEGUE (AWS real). Hay DOS pasos porque la distribución de CloudFront del sitio sirve
// también las fotos y el catálogo, y los buckets necesitan su id en la política OAC:
//   Paso A (no dependen de nadie): `site` (anota la salida `DistributionId` y el dominio
//     `*.cloudfront.net`), `admin-site`, `data`, `auth`.
//   Paso B (con SITE_DISTRIBUTION_ID, SITE_ORIGINS y ADMIN_ORIGINS ya conocidos): `publish`,
//     `media`, `api` y, al final, `observability`.
// `site` NO referencia a media/publish: los importa por nombre fijo (`lib/bucket-names.ts`), así que
// no hay ciclos ni `Fn::ImportValue`. Sin SITE_DISTRIBUTION_ID, media/publish se sintetizan sin
// permiso para CloudFront (falla cerrado: las fotos y el catálogo darían 403) y avisan.
new SiteStack(app, `canteras-site-${deploy.name}`, { env, deploy });
new AdminSiteStack(app, `canteras-admin-site-${deploy.name}`, {
  env,
  deploy,
  // `mediaOrigin` (CSP `img-src`) queda SIN cablear: el dashboard aún no muestra fotos. Cuando
  // muestre miniaturas, pasa aquí el origen del sitio (primer valor de SITE_ORIGINS).
});
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

// Id de la distribución de CloudFront del sitio (salida `DistributionId` de `canteras-site-<env>`),
// por entorno para no crear dependencias entre stacks. Lo usan media y publish (política OAC: solo
// esa distribución lee) y la API (invalidar caché al publicar). Un id con formato inválido LANZA.
const siteDistributionId = parseSiteDistributionId(process.env['SITE_DISTRIBUTION_ID']);

// Repositorio de GitHub (OIDC y reconstrucción del sitio). Los IDs numéricos salen de
// `gh api repos/<dueño>/<repo>`. Una sola definición: el CiStack confía en él y la API lo usa para
// pedir la reconstrucción, así que no pueden desincronizarse.
const github = {
  owner: 'GeoHdezAnd',
  ownerId: '154252360',
  repo: 'stone-store',
  repoId: '1461883588',
};

// Reconstrucción del sitio al publicar: nombre del parámetro SSM (SecureString) con el token de
// GitHub (PAT de un solo repo con `Actions: write`), que el dueño crea a mano. Sin él no se pasa la
// prop y la publicación responde `rebuild: 'not_configured'`. Con emulador se ignora (ver ApiStack).
// El workflow y la rama tienen valor por defecto; se validan en ApiStack.
const siteRebuildTokenParam = (process.env['SITE_REBUILD_TOKEN_PARAM'] ?? '').trim();
const siteRebuildWorkflow = (process.env['SITE_REBUILD_WORKFLOW'] ?? '').trim() || 'site-build.yml';
const siteRebuildRef = (process.env['SITE_REBUILD_REF'] ?? '').trim() || 'main';

// Fotos del catálogo: bucket privado al que el dashboard sube con URL prefirmada.
// Variantes de imagen (fase 6.3): la Lambda `MediaVariants` vive en este stack. El binario nativo de
// sharp se empaqueta SOLO con `-c packSharp=true` (necesita red; OBLIGATORIO fuera del emulador). Para
// `cdk synth`/`diff` sin red existe `-c skipSharpCheck=true` (NO usar para desplegar). La concurrencia
// reservada es opcional: `-c mediaVariantsReservedConcurrency=<n>` (ver `media-stack.ts`).
const flag = (v: unknown): boolean => v === true || v === 'true' || v === '1';
const packSharp = flag(app.node.tryGetContext('packSharp'));
const skipSharpCheck = flag(app.node.tryGetContext('skipSharpCheck'));
const reservedConcurrency = parseReservedConcurrency(
  app.node.tryGetContext(RESERVED_CONCURRENCY_CONTEXT),
);
const media = new MediaStack(app, `canteras-media-${deploy.name}`, {
  env,
  deploy,
  allowedOrigins,
  packSharp,
  skipSharpCheck,
  ...(siteDistributionId === undefined ? {} : { siteDistributionId }),
  ...(reservedConcurrency === undefined ? {} : { reservedConcurrency }),
});

// Catálogo publicado (`catalog.json`): bucket privado y versionado, distinto del del sitio.
const publish = new PublishStack(app, `canteras-publish-${deploy.name}`, {
  env,
  deploy,
  ...(siteDistributionId === undefined ? {} : { siteDistributionId }),
});

// Identidad verificada de SES desde la que se envían las cotizaciones (opcional). Sin ella, y fuera
// del emulador, enviar cotizaciones responde 409 `mail_not_configured`. El formato se valida en ApiStack.
const sesIdentityArn = (process.env['SES_IDENTITY_ARN'] ?? '').trim();

// Identidades SES de destinatarios (lista separada por comas, opcional; ver la prop en ApiStack).
const sesRecipientIdentityArns = (process.env['SES_RECIPIENT_IDENTITY_ARNS'] ?? '')
  .split(',')
  .map((a) => a.trim())
  .filter((a) => a !== '');

const api = new ApiStack(app, `canteras-api-${deploy.name}`, {
  env,
  deploy,
  ...(sesIdentityArn === '' ? {} : { sesIdentityArn }),
  ...(sesRecipientIdentityArns.length === 0 ? {} : { sesRecipientIdentityArns }),
  userPool: auth.userPool,
  userPoolClient: auth.userPoolClient,
  mediaBucket: media.bucket,
  publishBucket: publish.bucket,
  ...(siteDistributionId === undefined ? {} : { siteDistributionId }),
  ...(siteOrigins.length === 0 ? {} : { siteOrigins }),
  ...(adminBaseUrl === '' ? {} : { adminBaseUrl }),
  ...(turnstileSecretParam === '' ? {} : { turnstileSecretParam }),
  ...(siteRebuildTokenParam === ''
    ? {}
    : {
        siteRebuild: {
          tokenParam: siteRebuildTokenParam,
          repository: `${github.owner}/${github.repo}`,
          workflowFile: siteRebuildWorkflow,
          ref: siteRebuildRef,
        },
      }),
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
    postalCodes: data.postalCodes,
    routeCache: data.routeCache,
    ...(data.mailOutbox ? { mailOutbox: data.mailOutbox } : {}),
  },
  allowedOrigins,
});

// Alarmas y presupuestos (apilado DESPUÉS de Api). Correo de alertas en ALERT_EMAIL (se valida; nunca
// va en el repo). Fuera del emulador es obligatorio, pero para que `cdk synth` de los demás stacks no
// lo exija, sin él este stack simplemente no se instancia (aviso por stderr). Para desplegarlo:
// `ALERT_EMAIL=correo@dominio.com npx cdk deploy canteras-observability-dev`.
const alertEmail = parseAlertEmail(process.env[ALERT_EMAIL_ENV]);
if (alertEmail !== undefined || deploy.emulated) {
  new ObservabilityStack(app, `canteras-observability-${deploy.name}`, {
    env,
    deploy,
    httpApi: api.httpApi,
    // MediaVariants viene de MediaStack (Media -> Observability): Media no depende de Api.
    functions: { ...api.observedFunctions, MediaVariants: media.variantsFunction },
    quotesCreateLogGroup: api.quotesCreateLogGroup,
    ...(alertEmail === undefined ? {} : { alertEmail }),
  });
} else {
  console.error(
    `canteras-observability-${deploy.name} omitido: define ${ALERT_EMAIL_ENV} para incluirlo.`,
  );
}

// Identidad de CI/CD (OIDC de GitHub). Con `SITE_DISTRIBUTION_ID` crea además `SiteRebuildRole`
// (reconstrucción del sitio al publicar); sin él no se crea (falla cerrado).
// AWS permite un solo proveedor OIDC de GitHub por cuenta: si más adelante hay un CiStack de
// `prod` en la misma cuenta, pásale `existingOidcProviderArn` para no crear un segundo proveedor.
new CiStack(app, `canteras-ci-${deploy.name}`, {
  env,
  deploy,
  github,
  ...(siteDistributionId === undefined ? {} : { siteDistributionId }),
});

// Convención de etiquetas (CLAUDE.md 9.1): se aplican a todos los stacks.
Tags.of(app).add('Project', 'canteras-naturales');
Tags.of(app).add('Env', deploy.name);

app.synth();
