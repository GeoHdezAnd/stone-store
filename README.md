# Canteras Naturales

Sitio y tienda de cotizaciones de una cantera familiar de Puebla, México. Es un proyecto académico y de portafolio: el negocio es ficticio y todos los datos son de ejemplo.

## Estructura

- `apps/`: frontends (sitio público y dashboard del dueño). **Todavía no existe**: llega con la fase 2 (admin) y la fase 3 (sitio público).
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

1. **Fundamentos e infraestructura de hosting**, en curso:
   - [x] T0: repo, workspaces, TypeScript, lint con reglas de dependencias, pruebas y esqueleto de `infra`.
   - [ ] T1: `SiteStack` en CDK (S3 privado + CloudFront con OAC) con página provisional, probado en Floci.
   - [ ] T2: CI/CD con GitHub Actions y OIDC, con aprobación manual para desplegar.
   - [ ] T3: prueba de humo en AWS real (antes se revisa el `cdk diff`).
2. Autenticación y dashboard de solicitudes (Cognito, DynamoDB, API de administración, `apps/admin`).
3. Sitio público y formulario de cotización.
4. Flete automático.
5. Dashboard: catálogo, tarifas y publicar.
6. Métricas y operación.

## Desarrollo local con Floci

Floci es un emulador local de AWS. Se usa en las fases 1 a 3; la consola real solo para una prueba de humo por fase y para lo que el emulador no cubre.

```sh
docker run -d --name floci -p 4566:4566 \
  -v /var/run/docker.sock:/var/run/docker.sock -u root floci/floci:latest
curl localhost:4566/_floci/health

export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
       AWS_DEFAULT_REGION=us-east-1 AWS_ENDPOINT_URL=http://localhost:4566
```

Nunca combines estas variables con credenciales reales: `infra/lib/config.ts` lo rechaza. Límites conocidos y detalles en la sección 9.2 de [CLAUDE.md](./CLAUDE.md).

## Convenciones

- Textos visibles, comentarios, documentación y nombres de pruebas, en español de México. Identificadores, archivos y claves de JSON, en inglés.
- Los commits son convencionales y los redacta el dueño del repositorio.
- Versiones de dependencias fijadas (sin `^` ni `~`).

El plan completo del proyecto está en [CLAUDE.md](./CLAUDE.md).
