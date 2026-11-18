import { App, Tags } from 'aws-cdk-lib';
import { ApiStack } from '../lib/api-stack.js';
import { AuthStack } from '../lib/auth-stack.js';
import { CiStack } from '../lib/ci-stack.js';
import { resolveEnv } from '../lib/config.js';
import { DataStack } from '../lib/data-stack.js';
import { MediaStack } from '../lib/media-stack.js';
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

// Fotos del catálogo: bucket privado al que el dashboard sube con URL prefirmada.
const media = new MediaStack(app, `canteras-media-${deploy.name}`, {
  env,
  deploy,
  allowedOrigins,
});

new ApiStack(app, `canteras-api-${deploy.name}`, {
  env,
  deploy,
  userPool: auth.userPool,
  userPoolClient: auth.userPoolClient,
  mediaBucket: media.bucket,
  tables: {
    stones: data.stones,
    projects: data.projects,
    finishes: data.finishes,
    services: data.services,
    auditLog: data.auditLog,
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
