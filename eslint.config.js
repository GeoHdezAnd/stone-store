import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Todas las extensiones de código que el lint debe vigilar.
const EXT = '{ts,tsx,mts,cts,js,mjs}';

// Cada regla se define una sola vez y se usa en tres formas: import estático
// (no-restricted-imports), import() dinámico y require() (no-restricted-syntax).
// `source` es una regex (como cadena) que se evalúa sobre el especificador literal.
const aws = {
  source: '^(@aws-sdk/|@smithy/)',
  group: ['@aws-sdk/*', '@smithy/*'],
  message: 'El SDK de AWS solo se permite en services/* y scripts/*.',
};
const cdk = {
  source: '^(aws-cdk-lib($|/)|constructs$)',
  group: ['aws-cdk-lib', 'aws-cdk-lib/*', 'constructs'],
  message: 'CDK solo se permite en infra.',
};
const apps = {
  source: '(^|/)apps/|^@canteras/(web|admin)($|/)',
  group: ['**/apps/*', '@canteras/web', '@canteras/web/*', '@canteras/admin', '@canteras/admin/*'],
  message: 'No se debe importar desde apps/*.',
};
const services = {
  source: '(^|/)services/|^@canteras/api($|/)',
  group: ['**/services/*', '@canteras/api', '@canteras/api/*'],
  message: 'No se debe importar código runtime de services/* aquí.',
};
const infra = {
  source: '(^|/)infra($|/)|^@canteras/infra($|/)',
  group: ['**/infra', '**/infra/*', '@canteras/infra', '@canteras/infra/*'],
  message: 'No se debe importar desde infra.',
};
const workspace = {
  source: '^@canteras/',
  group: ['@canteras/*'],
  message:
    'packages/* no puede depender de ningún paquete del repo (ni @canteras/shared ni @canteras/ui).',
};

const restrict = (...rules) => ({
  'no-restricted-imports': [
    'error',
    { patterns: rules.map(({ group, message }) => ({ group, message })) },
  ],
  // Cierra los bypasses: import() dinámico y require() con especificador literal.
  'no-restricted-syntax': [
    'error',
    ...rules.flatMap(({ source, message }) => {
      // esquery no admite "/" sin escapar dentro de una regex.
      const re = source.replaceAll('/', '\\/');
      return [
        { selector: `ImportExpression[source.value=/${re}/]`, message },
        {
          selector: `CallExpression[callee.name='require'][arguments.0.value=/${re}/]`,
          message,
        },
      ];
    }),
  ],
});

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cdk.out/**',
      '**/coverage/**',
      '**/.astro/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.node } } },
  // Dirección de dependencias (CLAUDE.md 9.1)
  // packages/*: dominio/UI puro. No importan nada del repo, ni AWS SDK ni CDK.
  {
    files: [`packages/**/*.${EXT}`],
    rules: restrict(workspace, apps, services, infra, aws, cdk),
  },
  // apps/*: sin SDK de AWS, sin runtime de services, sin CDK.
  // Nota: los archivos .astro necesitan eslint-plugin-astro; se agrega al crear apps/web (fase 3).
  { files: [`apps/**/*.${EXT}`], rules: restrict(aws, services, infra, cdk) },
  // services/* y scripts/*: pueden usar shared y el SDK de AWS; no apps, infra ni CDK.
  { files: [`services/**/*.${EXT}`, `scripts/**/*.${EXT}`], rules: restrict(apps, infra, cdk) },
  // infra: solo CDK; sin runtime de services, sin apps, sin clientes del SDK de AWS.
  // DECISIÓN: infra SÍ puede importar @canteras/shared, pero solo se esperan constantes y tipos
  // (nunca lógica de runtime pesada).
  { files: [`infra/**/*.${EXT}`], rules: restrict(apps, services, aws) },
);
