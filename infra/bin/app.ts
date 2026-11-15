import { App, Tags } from 'aws-cdk-lib';
import { resolveEnv } from '../lib/config';

const deploy = resolveEnv();
const app = new App();

// Entorno resuelto y validado (cuenta/región). Los stacks de T1 deben recibirlo como
// `env: { account: deploy.account, region: deploy.region }` para tener un entorno fijo
// y no depender de la resolución implícita de CDK.
export const stackEnv = { account: deploy.account, region: deploy.region };

// Convención de etiquetas (CLAUDE.md 9.1). Los stacks llegan en T1.
Tags.of(app).add('Project', 'canteras-naturales');
Tags.of(app).add('Env', deploy.name);

app.synth();
