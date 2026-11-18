import { App, Tags } from 'aws-cdk-lib';
import { CiStack } from '../lib/ci-stack.js';
import { resolveEnv } from '../lib/config.js';
import { SiteStack } from '../lib/site-stack.js';

const deploy = resolveEnv();
const app = new App();

// Entorno fijo (cuenta y región validadas por resolveEnv). Si no hay cuenta (dev sin
// emulador ni credenciales), el stack queda agnóstico de cuenta.
const env = deploy.account
  ? { account: deploy.account, region: deploy.region }
  : { region: deploy.region };

new SiteStack(app, `canteras-site-${deploy.name}`, { env, deploy });

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
