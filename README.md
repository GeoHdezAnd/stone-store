# Canteras Naturales

Sitio y tienda de cotizaciones de una cantera familiar de Puebla, México. Es un proyecto académico y de portafolio: el negocio es ficticio y todos los datos son de ejemplo.

## Estructura

- `apps/`: frontends (sitio público y dashboard del dueño). **Todavía no existe**: llega con la fase 2 (admin) y la fase 4 (sitio público).
- `packages/`: código compartido (dominio, UI). Son paquetes internos: se consumen directo desde `src/index.ts`, sin compilar ni generar `dist`.
- `services/`: Lambdas y API (TypeScript).
- `infra/`: infraestructura como código con AWS CDK.
- `content/`: seed inicial del catálogo (JSON).
- `scripts/`: scripts de apoyo (importaciones, cargas).

Regla de dependencias: `apps` y `services` dependen de `packages`; `packages` no depende de nada del repo; `infra` puede usar `@canteras/shared` (solo constantes y tipos), pero nunca `apps` ni `services`. El lint la hace cumplir, incluidos `import()` dinámicos y `require()`.

## Requisitos

Node `22.23.4` exacto, según `.nvmrc` (`engines.node`: `^22.12.0 || >=24`). En CI hay que usar `node-version-file: .nvmrc` en `actions/setup-node`.

## Comandos

```sh
npm ci            # instalación limpia desde package-lock.json
npm run lint
npm run typecheck # tsc --noEmit por workspace; no genera archivos
npm run test
npm run build     # solo workspaces que definan `build`
```

## Estado

Orden de fases (el dashboard del dueño va antes que el sitio público; detalle en [CLAUDE.md](./CLAUDE.md), sección 11):

1. **Fundamentos e infraestructura de hosting**:
   - [x] T0: repo, workspaces, TypeScript, lint con reglas de dependencias, pruebas y esqueleto de `infra`.
   - [x] T1: `SiteStack` en CDK (S3 privado + CloudFront con OAC) con página provisional, probado en Floci. Lo que Floci no verifica (rechazo de lectura directa al bucket, OAC real) se comprueba en el hito de salida a AWS real.
   - [x] T2: CI/CD con GitHub Actions y OIDC (`CiStack`, `ci.yml`, `deploy.yml`), con tests de síntesis. `deploy.yml` queda dormido hasta el hito de salida.
2. Autenticación y dashboard: catálogo y configuración (Cognito, DynamoDB, API de administración, `apps/admin`).
3. Dashboard: publicar, tarifas y solicitudes.
4. Sitio público y formulario de cotización.

**Hito: salida a AWS real** (después de la fase 4, con el MVP probado en Floci): cuenta nueva, bootstrap acotado, `CiStack`, configuración de GitHub, primer despliegue y smoke test.

5. Flete automático.
6. Dashboard: métricas y operación.

## Desarrollo local con Floci

Floci es un emulador local de AWS. Se usa en las fases 1 a 4; AWS real solo en el hito de salida (después del MVP) y para lo que el emulador no cubre.

```sh
docker compose up -d        # desde la raíz; usa docker-compose.yml
curl localhost:4566/_floci/health

export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
       AWS_DEFAULT_REGION=us-east-1 AWS_ENDPOINT_URL=http://localhost:4566

# Desde infra/ (donde vive cdk.json):
npx cdk bootstrap aws://000000000000/us-east-1   # solo la primera vez o si se pierde el estado
# Hay 2 stacks (canteras-site-dev y canteras-ci-dev): indica siempre cuál.
npx cdk diff canteras-site-dev && npx cdk deploy canteras-site-dev --require-approval never

# Desde la raíz: publicar la página provisional
npx tsx scripts/sync-site.ts

unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION AWS_ENDPOINT_URL
```

Verificar CloudFront en Floci: `curl -H "Host: <dominio>.cloudfront.net" http://localhost:4566/`. Antes de `cdk destroy`, vacía el bucket a mano (con Floci se apaga `autoDeleteObjects`).

Nunca combines estas variables con credenciales reales: `infra/lib/config.ts` lo rechaza. Límites conocidos y detalles en la sección 9.2 de [CLAUDE.md](./CLAUDE.md).

## CI/CD (GitHub Actions + OIDC)

> **Estado:** `ci.yml` ya corre (no usa AWS). Todo lo demás de esta sección (`deploy.yml`, el environment, las variables y `CiStack` en AWS) está **dormido** hasta el hito de salida a AWS real, cuando exista la cuenta nueva y el MVP esté probado en Floci.

- `ci.yml`: typecheck, lint, formato, pruebas y `cdk synth` en cada PR y push a `main`. No usa credenciales de AWS.
- `deploy.yml`: despliegue manual a `dev`. Primero `accion=diff` (imprime el SHA), luego `accion=deploy` pegando ese SHA en `sha_revisado`.
- `CiStack` (`canteras-ci-dev`) crea el proveedor OIDC y el rol que asume el workflow. **Se despliega a mano, nunca desde CI.**

**Configuración en GitHub que el código no puede hacer** (sin esto el despliegue NO es seguro):

1. Settings → Environments → `dev`: _Required reviewers_ (tú) y _Deployment branches: Selected branches → `main`_. El rol de AWS solo confía en `environment:dev`, así que cualquier workflow de cualquier rama que declare ese environment obtendría el mismo token: la restricción de ramas es la barrera real.
2. Settings → Rules → ruleset sobre `main`: PR obligatorio **con 0 aprobaciones requeridas** (un autor no puede aprobar su propio PR; con 1 aprobación y un solo desarrollador nadie podría fusionar), sin force-push, sin borrado y el check `verify` de CI obligatorio. Se trabaja en `release/dev` y se fusiona a `main` por PR solo cuando se va a desplegar a AWS.
3. Variables del repo (no secretas): `AWS_ROLE_ARN` (salida `DeployRoleArn` de `CiStack`) y `AWS_ACCOUNT_ID`.

**Límite conocido:** el rol de CI asume el `deploy-role` del bootstrap de CDK, que en la práctica es administrador (CloudFormation crea los recursos con el `CloudFormationExecutionRole`). Por eso el bootstrap de la cuenta real debe hacerse con una política de ejecución acotada (`--cloudformation-execution-policies`), no con el `AdministratorAccess` por defecto. Eso se resuelve en el hito de salida a AWS real.

## Convenciones

- Textos visibles, comentarios, documentación y nombres de pruebas, en español de México. Identificadores, archivos y claves de JSON, en inglés.
- Los commits son convencionales y los redacta el dueño del repositorio.
- Versiones de dependencias fijadas (sin `^` ni `~`).

El plan completo del proyecto está en [CLAUDE.md](./CLAUDE.md).
