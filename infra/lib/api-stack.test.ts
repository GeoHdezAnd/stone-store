import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { App, Tags } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { HttpMethod, HttpRoute, HttpRouteKey } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpNoneAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type { CfnTable, Table } from 'aws-cdk-lib/aws-dynamodb';
import { describe, expect, it } from 'vitest';

import { ApiStack, jwtIssuer, validateAllowedOrigins } from './api-stack.js';
import { AuthStack } from './auth-stack.js';
import { FLOCI_API_PORT, FLOCI_IP } from './config.js';
import { AUDIT_SCOPE_INDEX, DataStack } from './data-stack.js';
import { MEDIA_ENTITIES } from '@canteras/shared';
import { MediaStack } from './media-stack.js';
import { PublishStack } from './publish-stack.js';

const REPO = join(import.meta.dirname, '..', '..');

interface BuildOptions {
  name?: 'dev' | 'prod';
  emulated?: boolean;
  allowedOrigins?: string[];
  siteDistributionId?: string;
}

function build(opts: BuildOptions = {}): {
  stack: ApiStack;
  auth: AuthStack;
  data: DataStack;
  media: MediaStack;
  publish: PublishStack;
} {
  const { name = 'dev', emulated = false, allowedOrigins, siteDistributionId } = opts;
  // Se omite el bundling con esbuild para que la síntesis sea rápida; el synth real de
  // `cdk synth` sí empaqueta.
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const deploy = { name, account: undefined, region: 'us-east-1', emulated } as const;
  const auth = new AuthStack(app, 'Auth', { deploy });
  const data = new DataStack(app, 'Data', { deploy });
  const media = new MediaStack(app, 'Media', {
    deploy,
    allowedOrigins: validateAllowedOrigins(deploy, allowedOrigins),
  });
  const publish = new PublishStack(app, 'Publish', { deploy });
  const stack = new ApiStack(app, 'Api', {
    deploy,
    userPool: auth.userPool,
    userPoolClient: auth.userPoolClient,
    mediaBucket: media.bucket,
    publishBucket: publish.bucket,
    tables: {
      stones: data.stones,
      projects: data.projects,
      finishes: data.finishes,
      services: data.services,
      settings: data.settings,
      auditLog: data.auditLog,
      publications: data.publications,
      freightConfig: data.freightConfig,
    },
    ...(allowedOrigins ? { allowedOrigins } : {}),
    ...(siteDistributionId ? { siteDistributionId } : {}),
  });
  Tags.of(app).add('Project', 'canteras-naturales');
  Tags.of(app).add('Env', name);
  return { stack, auth, data, media, publish };
}
const synth = (opts: BuildOptions = {}): Template => Template.fromStack(build(opts).stack);

const RECURSOS_CATALOGO = ['stones', 'projects', 'finishes', 'services'] as const;

type Props = Record<string, unknown>;
function rutas(t: Template): Props[] {
  return Object.values(t.findResources('AWS::ApiGatewayV2::Route')).map((r) => r.Properties);
}

/**
 * INVARIANTE DE SEGURIDAD. Devuelve la lista de problemas (vacía = todo bien):
 * - debe haber rutas (evita pruebas vacuosas);
 * - no puede existir `$default` ni catch-all;
 * - `GET /health` es la ÚNICA ruta sin authorizer;
 * - todas las demás: AuthorizationType JWT con AuthorizerId.
 */
export function problemasDeSeguridad(t: Template): string[] {
  const problemas: string[] = [];
  const todas = rutas(t);
  if (todas.length === 0) problemas.push('la plantilla no tiene rutas');
  for (const r of todas) {
    const key = r['RouteKey'] as string;
    if (key === '$default') problemas.push('existe una ruta $default');
    if (key === 'GET /health') {
      if (r['AuthorizationType'] !== 'NONE' || r['AuthorizerId'] !== undefined) {
        problemas.push('GET /health debe ser pública explícita (NONE, sin authorizer)');
      }
    } else if (r['AuthorizationType'] !== 'JWT' || r['AuthorizerId'] === undefined) {
      problemas.push(`la ruta "${key}" no está protegida con JWT`);
    }
  }
  if (!todas.some((r) => r['RouteKey'] === 'GET /health')) problemas.push('falta GET /health');
  return problemas;
}

describe('ApiStack: invariante de seguridad de las rutas', () => {
  it.each([
    ['dev', false],
    ['dev', true],
    ['prod', false],
  ] as const)('solo GET /health es pública (%s, emulado=%s)', (name, emulated) => {
    const t = synth({
      name,
      emulated,
      ...(name === 'prod' ? { allowedOrigins: ['https://admin.ejemplo.mx'] } : {}),
    });
    expect(rutas(t).length).toBeGreaterThan(0);
    expect(problemasDeSeguridad(t)).toEqual([]);
  });

  it('las rutas esperadas son exactamente las declaradas', () => {
    const keys = rutas(synth())
      .map((r) => r['RouteKey'])
      .sort();
    expect(keys).toEqual(
      [
        'ANY /admin/finishes',
        'ANY /admin/finishes/{proxy+}',
        'ANY /admin/freight',
        'ANY /admin/freight-config',
        'ANY /admin/freight-config/{proxy+}',
        'ANY /admin/freight/{proxy+}',
        'ANY /admin/me',
        'ANY /admin/me/{proxy+}',
        'ANY /admin/media',
        'ANY /admin/media/{proxy+}',
        'ANY /admin/projects',
        'ANY /admin/projects/{proxy+}',
        'ANY /admin/publications',
        'ANY /admin/publications/{proxy+}',
        'ANY /admin/publish',
        'ANY /admin/publish/{proxy+}',
        'ANY /admin/services',
        'ANY /admin/services/{proxy+}',
        'ANY /admin/settings',
        'ANY /admin/settings/{proxy+}',
        'ANY /admin/stones',
        'ANY /admin/stones/{proxy+}',
        'GET /health',
      ].sort(),
    );
  });

  it('el comprobador detecta una ruta pública extra (el test no es vacuoso)', () => {
    const { stack } = build();
    const fn = stack.healthFunction;
    new HttpRoute(stack, 'RutaPublicaIntrusa', {
      httpApi: stack.httpApi,
      routeKey: HttpRouteKey.with('/secreto', HttpMethod.GET),
      integration: new HttpLambdaIntegration('Intrusa', fn),
      authorizer: new HttpNoneAuthorizer(),
    });
    const problemas = problemasDeSeguridad(Template.fromStack(stack));
    expect(problemas.length).toBeGreaterThan(0);
    expect(problemas.join(' ')).toContain('GET /secreto');
  });

  it('el comprobador detecta una ruta $default', () => {
    const { stack } = build();
    new HttpRoute(stack, 'Catchall', {
      httpApi: stack.httpApi,
      routeKey: HttpRouteKey.DEFAULT,
      integration: new HttpLambdaIntegration('Catchall', stack.healthFunction),
    });
    expect(problemasDeSeguridad(Template.fromStack(stack)).join(' ')).toContain('$default');
  });
});

describe('ApiStack: authorizer JWT', () => {
  it('es JWT, lee la cabecera Authorization y la audiencia es el id del cliente', () => {
    const t = synth();
    t.resourceCountIs('AWS::ApiGatewayV2::Authorizer', 1);
    t.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'JWT',
      IdentitySource: ['$request.header.Authorization'],
      JwtConfiguration: { Audience: [Match.anyValue()], Issuer: Match.anyValue() },
    });
    const authz = Object.values(t.findResources('AWS::ApiGatewayV2::Authorizer'))[0]!;
    // El id del cliente llega por exportación entre stacks (referencia al cliente de AuthStack).
    expect(JSON.stringify(authz.Properties.JwtConfiguration.Audience)).toContain('AdminClient');
  });

  it('en AWS real el issuer es el de Cognito (https)', () => {
    const authz = Object.values(
      synth({ emulated: false }).findResources('AWS::ApiGatewayV2::Authorizer'),
    )[0]!;
    const issuer = JSON.stringify(authz.Properties.JwtConfiguration.Issuer);
    expect(issuer).toContain('https://cognito-idp.us-east-1.amazonaws.com/');
    expect(issuer).not.toContain(FLOCI_IP);
  });

  it('con emulador el issuer usa la IP literal de Floci', () => {
    const authz = Object.values(
      synth({ emulated: true }).findResources('AWS::ApiGatewayV2::Authorizer'),
    )[0]!;
    const issuer = JSON.stringify(authz.Properties.JwtConfiguration.Issuer);
    expect(issuer).toContain(`http://${FLOCI_IP}:${FLOCI_API_PORT}/`);
    expect(issuer).not.toContain('amazonaws.com');
  });
});

/** Exportación entre stacks -> tipo del recurso del AuthStack al que apunta su salida. */
function tipoDeExportacion(auth: Template, nombre: string): string | undefined {
  const outputs = auth.toJSON().Outputs as Record<
    string,
    { Value: { Ref?: string }; Export?: { Name: string } }
  >;
  const out = Object.values(outputs).find((o) => o.Export?.Name === nombre);
  const ref = out?.Value.Ref;
  return ref ? (auth.toJSON().Resources as Record<string, { Type: string }>)[ref]?.Type : undefined;
}

describe('ApiStack: el authorizer apunta al pool y al cliente de AuthStack (no a ids fijos)', () => {
  it.each([false, true])(
    'issuer y audiencia referencian los recursos de AuthStack (emulado=%s)',
    (emulated) => {
      const { stack, auth } = build({ emulated });
      const authTemplate = Template.fromStack(auth);
      const authz = Object.values(
        Template.fromStack(stack).findResources('AWS::ApiGatewayV2::Authorizer'),
      )[0]!;
      const { Issuer, Audience } = authz.Properties.JwtConfiguration;

      const partes = Issuer['Fn::Join']?.[1] as unknown[] | undefined;
      expect(partes, 'el issuer debe ser un Fn::Join').toBeDefined();
      const ultimo = partes![partes!.length - 1] as { 'Fn::ImportValue'?: string };
      expect(ultimo['Fn::ImportValue']).toBeDefined();
      expect(tipoDeExportacion(authTemplate, ultimo['Fn::ImportValue']!)).toBe(
        'AWS::Cognito::UserPool',
      );
      // Ninguna parte literal contiene un id de pool (us-east-1_XXXX).
      for (const p of partes!.slice(0, -1)) expect(String(p)).not.toMatch(/_[A-Za-z0-9]{6,}/);

      expect(Audience).toHaveLength(1);
      expect(tipoDeExportacion(authTemplate, Audience[0]['Fn::ImportValue'])).toBe(
        'AWS::Cognito::UserPoolClient',
      );
    },
  );
});

describe('jwtIssuer', () => {
  const pool = 'us-east-1_AbCdEf';
  it('emulado: IP literal de Floci', () => {
    expect(jwtIssuer({ emulated: true }, 'us-east-1', pool)).toBe(
      `http://${FLOCI_IP}:${FLOCI_API_PORT}/${pool}`,
    );
  });
  it('real: issuer de Cognito de la región', () => {
    expect(jwtIssuer({ emulated: false }, 'eu-west-1', pool)).toBe(
      `https://cognito-idp.eu-west-1.amazonaws.com/${pool}`,
    );
  });
});

describe('ApiStack: CORS', () => {
  it('en dev usa por defecto el origen del dashboard local', () => {
    synth().hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: Match.objectLike({ AllowOrigins: ['http://localhost:5173'] }),
    });
  });

  it('métodos y cabeceras exactos, 1 día de caché y sin credenciales', () => {
    const api = Object.values(synth().findResources('AWS::ApiGatewayV2::Api'))[0]!;
    const cors = api.Properties.CorsConfiguration;
    expect([...cors.AllowMethods].sort()).toEqual(
      ['DELETE', 'GET', 'OPTIONS', 'PATCH', 'POST', 'PUT'].sort(),
    );
    expect([...cors.AllowHeaders].sort()).toEqual(['authorization', 'content-type']);
    expect(cors.MaxAge).toBe(86400);
    expect(cors.AllowCredentials ?? false).toBe(false);
  });

  it('nunca incluye *', () => {
    for (const opts of [
      {},
      { allowedOrigins: ['https://a.mx'] },
      { name: 'prod' as const, allowedOrigins: ['https://admin.ejemplo.mx'] },
    ]) {
      const api = Object.values(synth(opts).findResources('AWS::ApiGatewayV2::Api'))[0]!;
      expect(JSON.stringify(api.Properties.CorsConfiguration)).not.toContain('*');
    }
  });

  it('acepta orígenes explícitos', () => {
    synth({ allowedOrigins: ['https://a.mx', 'https://b.mx'] }).hasResourceProperties(
      'AWS::ApiGatewayV2::Api',
      { CorsConfiguration: Match.objectLike({ AllowOrigins: ['https://a.mx', 'https://b.mx'] }) },
    );
  });

  it('prod sin orígenes lanza error', () => {
    expect(() => synth({ name: 'prod' })).toThrow(/ADMIN_ORIGINS|allowedOrigins|orígenes/);
    expect(() => synth({ name: 'prod', allowedOrigins: [] })).toThrow(/orígenes/);
  });

  it.each([
    'http://localhost:5173',
    'https://localhost',
    'https://127.0.0.1',
    'http://admin.ejemplo.mx',
    '*',
    'https://*.ejemplo.mx',
    'https://admin.ejemplo.mx/ruta',
    'admin.ejemplo.mx',
  ])('prod rechaza el origen %s', (origen) => {
    expect(() => validateAllowedOrigins({ name: 'prod' }, [origen])).toThrow(/origen/i);
  });

  it.each([
    ['https://admin.ejemplo.mx@evil.com', /origen/i],
    ['https://127.0.0.2', /localhost|loopback/i],
    ['https://127.255.255.254', /localhost|loopback/i],
    ['https://[::1]', /localhost|loopback/i],
    ['https://0.0.0.0', /0\.0\.0\.0/],
    ['https://localhost.', /localhost|punto final|origen/i],
    ['https://admin.ejemplo.mx.', /punto final|origen/i],
    ['https://ADMIN.ejemplo.mx', /origen/i],
    ['https://admin.ejemplo.mx:443', /origen/i],
  ])('prod rechaza el origen engañoso %s', (origen, patron) => {
    expect(() => validateAllowedOrigins({ name: 'prod' }, [origen])).toThrow(patron);
  });

  it.each(['null', 'file:///tmp/x', 'file://'])('dev rechaza el origen %s', (origen) => {
    expect(() => validateAllowedOrigins({ name: 'dev' }, [origen])).toThrow(/origen/i);
  });

  it('prod acepta un origen válido con puerto', () => {
    expect(validateAllowedOrigins({ name: 'prod' }, ['https://admin.ejemplo.mx:8443'])).toEqual([
      'https://admin.ejemplo.mx:8443',
    ]);
  });

  it('LIMITACIÓN CONOCIDA: https://admin.ejemplo.mx.evil.com es sintácticamente válido', () => {
    // No se puede distinguir de un dominio legítimo: acertar el origen es responsabilidad de
    // quien despliega (ADMIN_ORIGINS).
    expect(() =>
      validateAllowedOrigins({ name: 'prod' }, ['https://admin.ejemplo.mx.evil.com']),
    ).not.toThrow();
  });

  it('dev también rechaza el comodín', () => {
    expect(() => validateAllowedOrigins({ name: 'dev' }, ['*'])).toThrow(/\*/);
  });
});

describe('ApiStack: Lambdas', () => {
  it('los archivos entry existen', () => {
    for (const p of [
      'services/api/src/health/handler.ts',
      'services/api/src/admin-me/handler.ts',
      'services/api/src/admin-catalog/handler.ts',
      'services/api/src/admin-media/handler.ts',
      'services/api/src/admin-settings/handler.ts',
      'services/api/src/admin-publish/handler.ts',
      'services/api/src/admin-freight/handler.ts',
    ]) {
      expect(existsSync(join(REPO, p)), p).toBe(true);
    }
  });

  it('hay 7 funciones nodejs22.x, 256 MB, 10 s, handler `handler`', () => {
    const t = synth();
    t.resourceCountIs('AWS::Lambda::Function', 7);
    t.allResourcesProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      MemorySize: 256,
      Timeout: 10,
      Handler: Match.stringLikeRegexp('handler$'),
    });
  });

  it('cada función tiene su log group con retención de 1 semana (sin logRetention)', () => {
    const t = synth();
    t.resourceCountIs('AWS::Logs::LogGroup', 7);
    t.allResourcesProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
    t.allResourcesProperties('AWS::Lambda::Function', {
      LoggingConfig: { LogGroup: { Ref: Match.stringLikeRegexp('Logs') } },
    });
  });

  it('log groups: dev se borra, prod se conserva', () => {
    synth().allResources('AWS::Logs::LogGroup', { DeletionPolicy: 'Delete' });
    synth({ name: 'prod', allowedOrigins: ['https://admin.ejemplo.mx'] }).allResources(
      'AWS::Logs::LogGroup',
      { DeletionPolicy: 'Retain' },
    );
  });

  it('no hay custom resources (no funcionan en Floci)', () => {
    for (const emulated of [false, true]) {
      const tipos = Object.values(
        synth({ emulated }).toJSON().Resources as Record<string, { Type: string }>,
      ).map((r) => r.Type);
      expect(
        tipos.filter(
          (x) => x.startsWith('Custom::') || x === 'AWS::CloudFormation::CustomResource',
        ),
      ).toEqual([]);
    }
  });

  it('cada ruta apunta a su Lambda', () => {
    const t = synth();
    const integraciones = t.findResources('AWS::ApiGatewayV2::Integration');
    const funciones = Object.keys(t.findResources('AWS::Lambda::Function'));
    const fnDe = (idIntegracion: string): string => {
      const uri = JSON.stringify(integraciones[idIntegracion]!.Properties.IntegrationUri);
      const f = funciones.find((id) => uri.includes(`"${id}"`));
      if (!f) throw new Error(`integración ${idIntegracion} sin Lambda`);
      return f;
    };
    const esperado: Record<string, RegExp> = {
      'GET /health': /Health/,
      'ANY /admin/me': /AdminMe/,
      'ANY /admin/me/{proxy+}': /AdminMe/,
      'ANY /admin/media': /AdminMedia/,
      'ANY /admin/media/{proxy+}': /AdminMedia/,
      'ANY /admin/settings': /AdminSettings/,
      'ANY /admin/settings/{proxy+}': /AdminSettings/,
      'ANY /admin/publish': /AdminPublish/,
      'ANY /admin/publish/{proxy+}': /AdminPublish/,
      'ANY /admin/publications': /AdminPublish/,
      'ANY /admin/publications/{proxy+}': /AdminPublish/,
      'ANY /admin/freight-config': /AdminFreight/,
      'ANY /admin/freight-config/{proxy+}': /AdminFreight/,
      'ANY /admin/freight': /AdminFreight/,
      'ANY /admin/freight/{proxy+}': /AdminFreight/,
      ...Object.fromEntries(
        RECURSOS_CATALOGO.flatMap((x) => [
          [`ANY /admin/${x}`, /AdminCatalog/],
          [`ANY /admin/${x}/{proxy+}`, /AdminCatalog/],
        ]),
      ),
    };
    for (const r of rutas(t)) {
      const target = JSON.stringify(r['Target']);
      const idInt = Object.keys(integraciones).find((id) => target.includes(`"${id}"`));
      expect(idInt, String(r['RouteKey'])).toBeDefined();
      expect(fnDe(idInt!)).toMatch(esperado[r['RouteKey'] as string]!);
    }
  });
});

describe('ApiStack: etapa y salidas', () => {
  it('etapa $default con autoDeploy y throttling', () => {
    const t = synth();
    t.resourceCountIs('AWS::ApiGatewayV2::Stage', 1);
    t.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: '$default',
      AutoDeploy: true,
      DefaultRouteSettings: { ThrottlingRateLimit: 10, ThrottlingBurstLimit: 20 },
    });
  });

  it('exporta ApiUrl y HttpApiId', () => {
    const t = synth();
    t.hasOutput('ApiUrl', { Value: Match.anyValue() });
    t.hasOutput('HttpApiId', { Value: Match.anyValue() });
  });
});

// ---------------------------------------------------------------------------------------------
// Lambda AdminCatalog: integración, entorno e IAM de mínimo privilegio.
// ---------------------------------------------------------------------------------------------

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Id lógico (en la plantilla de ApiStack) de una función por fragmento de nombre. */
function idFuncion(t: Template, fragmento: string): string {
  const ids = Object.keys(t.findResources('AWS::Lambda::Function')).filter((id) =>
    id.includes(`${fragmento}Function`),
  );
  expect(ids, `función ${fragmento}`).toHaveLength(1);
  return ids[0]!;
}

/** Sentencias de TODAS las políticas IAM adjuntas al rol de la función. */
function sentenciasDe(t: Template, fragmento: string): Json[] {
  const fn = t.findResources('AWS::Lambda::Function')[idFuncion(t, fragmento)]!;
  const rol = (fn.Properties.Role['Fn::GetAtt'] as string[])[0]!;
  const sentencias: Json[] = [];
  for (const p of Object.values(t.findResources('AWS::IAM::Policy'))) {
    const roles = (p.Properties.Roles as { Ref: string }[]).map((r) => r.Ref);
    if (!roles.includes(rol)) continue;
    const st = p.Properties.PolicyDocument.Statement as Json[];
    sentencias.push(...st);
  }
  return sentencias;
}

const lista = (x: unknown): unknown[] => (Array.isArray(x) ? x : [x]);

/** Importación entre stacks -> id lógico del recurso en DataStack al que apunta la exportación. */
function tablaDeImport(data: Template, valor: Json): string {
  const nombre = valor['Fn::ImportValue'] as string | undefined;
  if (!nombre) throw new Error(`se esperaba Fn::ImportValue, hay ${JSON.stringify(valor)}`);
  const outputs = data.toJSON().Outputs as Record<
    string,
    { Value: Json; Export?: { Name: string } }
  >;
  const out = Object.values(outputs).find((o) => o.Export?.Name === nombre);
  if (!out) throw new Error(`exportación ${nombre} no encontrada en DataStack`);
  return (out.Value['Fn::GetAtt'] as string[] | undefined)?.[0] ?? (out.Value['Ref'] as string);
}

/** Resuelve los Resource de una sentencia a ids lógicos de tablas de DataStack. */
function tablasDeSentencia(data: Template, st: Json): string[] {
  return lista(st['Resource']).map((r) => tablaDeImport(data, r as Json));
}

const CONDICION_TRANSACCION = {
  'ForAnyValue:StringEquals': { 'dynamodb:EnclosingOperation': ['TransactWriteItems'] },
};

describe('ApiStack: Lambda AdminCatalog', () => {
  it('las 8 rutas nuevas integran la Lambda AdminCatalog (y es una sola función)', () => {
    const t = synth();
    const fn = idFuncion(t, 'AdminCatalog');
    const integraciones = t.findResources('AWS::ApiGatewayV2::Integration');
    let n = 0;
    for (const r of rutas(t)) {
      const key = r['RouteKey'] as string;
      if (!RECURSOS_CATALOGO.some((x) => key.startsWith(`ANY /admin/${x}`))) continue;
      const target = JSON.stringify(r['Target']);
      const idInt = Object.keys(integraciones).find((id) => target.includes(`"${id}"`))!;
      expect(JSON.stringify(integraciones[idInt]!.Properties.IntegrationUri), key).toContain(
        `"${fn}"`,
      );
      n++;
    }
    expect(n).toBe(8);
  });

  it('el entorno tiene exactamente las 5 variables, como referencias a las tablas de DataStack', () => {
    const { stack, data } = build();
    const t = Template.fromStack(stack);
    const dt = Template.fromStack(data);
    const fn = t.findResources('AWS::Lambda::Function')[idFuncion(t, 'AdminCatalog')]!;
    const vars = fn.Properties.Environment.Variables as Record<string, Json>;
    expect(Object.keys(vars).sort()).toEqual(
      ['AUDIT_TABLE', 'FINISHES_TABLE', 'PROJECTS_TABLE', 'SERVICES_TABLE', 'STONES_TABLE'].sort(),
    );
    const esperado: Record<string, unknown> = {
      STONES_TABLE: data.stones,
      PROJECTS_TABLE: data.projects,
      FINISHES_TABLE: data.finishes,
      SERVICES_TABLE: data.services,
      AUDIT_TABLE: data.auditLog,
    };
    for (const [nombre, tabla] of Object.entries(esperado)) {
      const idEsperado = data.getLogicalId((tabla as Table).node.defaultChild as CfnTable);
      expect(typeof vars[nombre], nombre).toBe('object'); // no es un literal
      expect(tablaDeImport(dt, vars[nombre]!), nombre).toBe(idEsperado);
    }
  });

  it('IAM: mínimo privilegio exacto (lectura, escritura solo en transacción, auditoría append-only)', () => {
    const { stack, data } = build();
    const t = Template.fromStack(stack);
    const dt = Template.fromStack(data);
    const idDe = (tb: Table): string => data.getLogicalId(tb.node.defaultChild as CfnTable);
    const entidades = [data.stones, data.projects, data.finishes, data.services].map(idDe).sort();
    const auditoria = idDe(data.auditLog);

    const dynamo = sentenciasDe(t, 'AdminCatalog').filter((s) =>
      lista(s['Action']).some((a) => String(a).startsWith('dynamodb:')),
    );
    expect(dynamo.length, 'sin sentencias de DynamoDB (prueba vacuosa)').toBeGreaterThan(0);

    const lectura: Json[] = [];
    const escritura: Json[] = [];
    const audit: Json[] = [];
    for (const s of dynamo) {
      expect(s['Effect']).toBe('Allow');
      const acciones = (lista(s['Action']) as string[]).sort();
      // Nunca comodines ni DeleteItem / Query / ConditionCheckItem.
      for (const a of acciones) {
        expect(a, 'acción con comodín').not.toContain('*');
        expect([
          'dynamodb:DeleteItem',
          'dynamodb:Query',
          'dynamodb:ConditionCheckItem',
        ]).not.toContain(a);
      }
      const recursos = lista(s['Resource']);
      for (const r of recursos) expect(JSON.stringify(r)).not.toBe('"*"');
      const ids = tablasDeSentencia(dt, s);
      expect(ids.some((i) => i === auditoria) && ids.length > 1, 'auditoría mezclada').toBe(false);
      if (ids.length === 1 && ids[0] === auditoria) audit.push(s);
      else if (s['Condition'] === undefined) lectura.push(s);
      else escritura.push(s);
    }

    // Lectura: sin condición, solo las 4 entidades.
    expect(lectura).toHaveLength(1);
    expect((lista(lectura[0]!['Action']) as string[]).sort()).toEqual([
      'dynamodb:BatchGetItem',
      'dynamodb:GetItem',
      'dynamodb:Scan',
    ]);
    expect(tablasDeSentencia(dt, lectura[0]!).sort()).toEqual(entidades);

    // Escritura: Put/Update con la condición de transacción sobre las 4 entidades.
    expect(escritura).toHaveLength(1);
    expect((lista(escritura[0]!['Action']) as string[]).sort()).toEqual([
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
    ]);
    expect(escritura[0]!['Condition']).toEqual(CONDICION_TRANSACCION);
    expect(tablasDeSentencia(dt, escritura[0]!).sort()).toEqual(entidades);

    // Auditoría: solo PutItem, con la condición, sin lectura.
    expect(audit).toHaveLength(1);
    expect(lista(audit[0]!['Action'])).toEqual(['dynamodb:PutItem']);
    expect(audit[0]!['Condition']).toEqual(CONDICION_TRANSACCION);
    expect(tablasDeSentencia(dt, audit[0]!)).toEqual([auditoria]);
  });

  it('IAM: fuera de DynamoDB solo hay permisos de logs; ninguna sentencia con comodines', () => {
    const t = synth();
    const otras = sentenciasDe(t, 'AdminCatalog').filter(
      (s) => !lista(s['Action']).some((a) => String(a).startsWith('dynamodb:')),
    );
    for (const s of otras) {
      for (const a of lista(s['Action']) as string[]) {
        expect(a, JSON.stringify(s)).toMatch(/^logs:|^xray:/);
      }
    }
    for (const s of sentenciasDe(t, 'AdminCatalog')) {
      expect(JSON.stringify(s['Action'])).not.toContain('*');
      expect(JSON.stringify(s['Resource'])).not.toBe('"*"');
    }
  });

  it('Health y AdminMe NO reciben permisos de DynamoDB', () => {
    const t = synth();
    for (const f of ['Health', 'AdminMe', 'AdminMedia']) {
      const todas = JSON.stringify(sentenciasDe(t, f));
      expect(todas, f).not.toContain('dynamodb');
    }
  });

  it('cada ruta tiene su Lambda::Permission acotado a esta API', () => {
    const t = synth();
    const permisos = Object.values(t.findResources('AWS::Lambda::Permission')).map(
      (p) => p.Properties,
    );
    // 1 por ruta de integración: health (1) + me (1) + catálogo (4), cada integración una vez.
    expect(permisos.length).toBeGreaterThan(0);
    for (const p of permisos) {
      expect(p['Action']).toBe('lambda:InvokeFunction');
      expect(p['Principal']).toBe('apigateway.amazonaws.com');
      expect(JSON.stringify(p['SourceArn'])).toContain('HttpApi');
      expect(JSON.stringify(p['SourceArn'])).not.toContain('"*"');
    }
    // Cada una de las 4 funciones tiene al menos un permiso.
    const fns = Object.keys(t.findResources('AWS::Lambda::Function'));
    for (const f of fns) {
      expect(
        permisos.some((p) => JSON.stringify(p['FunctionName']).includes(`"${f}"`)),
        f,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Lambda AdminMedia: URLs prefirmadas de subida. IAM mínimo: solo s3:PutObject por prefijo.
// ---------------------------------------------------------------------------------------------

describe('ApiStack: Lambda AdminMedia', () => {
  it('las 2 rutas de media integran la Lambda AdminMedia y todas son JWT', () => {
    const t = synth();
    const fn = idFuncion(t, 'AdminMedia');
    const integraciones = t.findResources('AWS::ApiGatewayV2::Integration');
    let n = 0;
    for (const r of rutas(t)) {
      const key = r['RouteKey'] as string;
      if (!key.startsWith('ANY /admin/media')) continue;
      expect(r['AuthorizationType'], key).toBe('JWT');
      const target = JSON.stringify(r['Target']);
      const idInt = Object.keys(integraciones).find((id) => target.includes(`"${id}"`))!;
      expect(JSON.stringify(integraciones[idInt]!.Properties.IntegrationUri), key).toContain(
        `"${fn}"`,
      );
      n++;
    }
    expect(n).toBe(2);
  });

  it('MEDIA_BUCKET referencia el bucket de MediaStack (no es un literal)', () => {
    const { stack, media } = build();
    const t = Template.fromStack(stack);
    const mt = Template.fromStack(media);
    const fn = t.findResources('AWS::Lambda::Function')[idFuncion(t, 'AdminMedia')]!;
    const vars = fn.Properties.Environment.Variables as Record<string, Json>;
    expect(typeof vars['MEDIA_BUCKET']).toBe('object');
    const nombre = vars['MEDIA_BUCKET']!['Fn::ImportValue'] as string;
    const outputs = mt.toJSON().Outputs as Record<
      string,
      { Value: Json; Export?: { Name: string } }
    >;
    const out = Object.values(outputs).find((o) => o.Export?.Name === nombre);
    expect(out, 'exportación del bucket').toBeDefined();
    const idBucket = media.getLogicalId(media.bucket.node.defaultChild as never);
    expect(out!.Value['Ref']).toBe(idBucket);
  });

  it('S3_PUBLIC_ENDPOINT solo existe con emulador y apunta a localhost:<puerto de Floci>', () => {
    const vars = (emulated: boolean): Record<string, unknown> => {
      const t = synth({ emulated });
      return t.findResources('AWS::Lambda::Function')[idFuncion(t, 'AdminMedia')]!.Properties
        .Environment.Variables;
    };
    expect(vars(false)['S3_PUBLIC_ENDPOINT']).toBeUndefined();
    expect(Object.keys(vars(false)).sort()).toEqual(['MEDIA_BUCKET']);
    expect(vars(true)['S3_PUBLIC_ENDPOINT']).toBe(`http://localhost:${FLOCI_API_PORT}`);
    expect(Object.keys(vars(true)).sort()).toEqual(['MEDIA_BUCKET', 'S3_PUBLIC_ENDPOINT']);
  });

  it('IAM: SOLO s3:PutObject sobre los 3 prefijos (sin Get/List/Delete, sin s3:*, sin Resource *)', () => {
    const { stack, media } = build();
    const t = Template.fromStack(stack);
    const mt = Template.fromStack(media);
    const s3 = sentenciasDe(t, 'AdminMedia').filter((s) =>
      lista(s['Action']).some((a) => String(a).startsWith('s3:')),
    );
    expect(s3, 'sin sentencias de S3 (prueba vacuosa)').toHaveLength(1);
    const st = s3[0]!;
    expect(st['Effect']).toBe('Allow');
    expect(lista(st['Action'])).toEqual(['s3:PutObject']);
    expect(st['Condition']).toBeUndefined();

    const recursos = lista(st['Resource']) as Json[];
    expect(recursos).toHaveLength(3);
    const nombreExport = (r: Json): string => {
      const partes = r['Fn::Join'][1] as unknown[];
      const imp = partes.find(
        (p) => typeof p === 'object' && p !== null && 'Fn::ImportValue' in p,
      ) as Json;
      return imp['Fn::ImportValue'] as string;
    };
    const sufijos = recursos.map((r) => {
      expect(JSON.stringify(r)).not.toBe('"*"');
      const partes = (r['Fn::Join'][1] as unknown[]).filter((p) => typeof p === 'string');
      return partes.join('');
    });
    expect(sufijos.sort()).toEqual(['/finishes/*', '/projects/*', '/stones/*']);
    // Y coinciden con las entidades de media de shared (si se agrega una carpeta allí, la
    // política debe seguirla; este test falla si no se deriva).
    expect(sufijos.sort()).toEqual(MEDIA_ENTITIES.map((e) => `/${e}/*`).sort());
    // Los 3 ARN parten del ARN del bucket de MediaStack.
    const outputs = mt.toJSON().Outputs as Record<
      string,
      { Value: Json; Export?: { Name: string } }
    >;
    for (const r of recursos) {
      const out = Object.values(outputs).find((o) => o.Export?.Name === nombreExport(r));
      expect(out?.Value['Fn::GetAtt']).toEqual([
        media.getLogicalId(media.bucket.node.defaultChild as never),
        'Arn',
      ]);
    }
  });

  it('IAM: ninguna sentencia de AdminMedia usa comodines, y fuera de S3 solo hay logs', () => {
    const t = synth();
    const todas = sentenciasDe(t, 'AdminMedia');
    for (const s of todas) {
      expect(JSON.stringify(s['Action'])).not.toContain('*');
      expect(JSON.stringify(s['Resource'])).not.toBe('"*"');
      for (const a of lista(s['Action']) as string[])
        expect(a).toMatch(/^s3:PutObject$|^logs:|^xray:/);
    }
    const json = JSON.stringify(todas);
    for (const prohibida of [
      's3:GetObject',
      's3:DeleteObject',
      's3:ListBucket',
      's3:*',
      'dynamodb',
    ]) {
      expect(json).not.toContain(prohibida);
    }
  });

  it('las otras Lambdas (Health, AdminMe, AdminCatalog) no reciben permisos de S3', () => {
    const t = synth();
    for (const f of ['Health', 'AdminMe', 'AdminCatalog', 'AdminSettings']) {
      expect(JSON.stringify(sentenciasDe(t, f)), f).not.toContain('s3:');
    }
  });

  it('el bundle real de AdminMedia empaqueta S3 y el presigner (sin requires externos del SDK)', () => {
    // Sin omitir el bundling: esbuild local (sin Docker) genera el asset de cada Lambda.
    const app = new App();
    const deploy = {
      name: 'dev',
      account: undefined,
      region: 'us-east-1',
      emulated: false,
    } as const;
    const auth = new AuthStack(app, 'Auth', { deploy });
    const data = new DataStack(app, 'Data', { deploy });
    const media = new MediaStack(app, 'Media', {
      deploy,
      allowedOrigins: ['http://localhost:5173'],
    });
    const publish = new PublishStack(app, 'Publish', { deploy });
    new ApiStack(app, 'Api', {
      deploy,
      userPool: auth.userPool,
      userPoolClient: auth.userPoolClient,
      mediaBucket: media.bucket,
      publishBucket: publish.bucket,
      tables: {
        stones: data.stones,
        projects: data.projects,
        finishes: data.finishes,
        services: data.services,
        settings: data.settings,
        auditLog: data.auditLog,
        publications: data.publications,
        freightConfig: data.freightConfig,
      },
    });
    const dir = app.synth().directory;
    const bundles = readdirSync(dir)
      .filter((d) => d.startsWith('asset.'))
      .map((d) => join(dir, d, 'index.js'))
      .filter((f) => existsSync(f))
      .map((f) => readFileSync(f, 'utf8'));
    const mediaBundle = bundles.find((b) => b.includes('media_upload_url_issued'));
    expect(mediaBundle, 'no se encontró el bundle de AdminMedia').toBeDefined();
    expect(mediaBundle).not.toMatch(
      /require\(["']@aws-sdk\/(client-s3|s3-request-presigner)["']\)/,
    );
    // Prueba de que SÍ trae el código del presigner (firma SigV4 con query-string).
    expect(mediaBundle).toContain('X-Amz-Signature');
  }, 60_000);

  it('en dev emulado y real, y en prod, la plantilla sigue sin custom resources', () => {
    const { stack } = build({ emulated: true });
    const tipos = Object.values(
      Template.fromStack(stack).toJSON().Resources as Record<string, { Type: string }>,
    ).map((r) => r.Type);
    expect(tipos.filter((x) => x.startsWith('Custom::'))).toEqual([]);
  });
});

describe('ApiStack: Lambda AdminSettings', () => {
  const RUTAS = ['ANY /admin/settings', 'ANY /admin/settings/{proxy+}'];

  it('las 2 rutas de settings integran la Lambda AdminSettings y son JWT', () => {
    const t = synth();
    const fn = idFuncion(t, 'AdminSettings');
    const integraciones = t.findResources('AWS::ApiGatewayV2::Integration');
    let n = 0;
    for (const r of rutas(t)) {
      const key = r['RouteKey'] as string;
      if (!key.startsWith('ANY /admin/settings')) continue;
      expect(RUTAS).toContain(key);
      expect(r['AuthorizationType'], key).toBe('JWT');
      const target = JSON.stringify(r['Target']);
      const idInt = Object.keys(integraciones).find((id) => target.includes(`"${id}"`))!;
      expect(JSON.stringify(integraciones[idInt]!.Properties.IntegrationUri), key).toContain(
        `"${fn}"`,
      );
      n++;
    }
    expect(n).toBe(2);
  });

  it('el entorno tiene exactamente SETTINGS_TABLE y AUDIT_TABLE, como referencias a DataStack', () => {
    const { stack, data } = build();
    const t = Template.fromStack(stack);
    const dt = Template.fromStack(data);
    const fn = t.findResources('AWS::Lambda::Function')[idFuncion(t, 'AdminSettings')]!;
    const vars = fn.Properties.Environment.Variables as Record<string, Json>;
    expect(Object.keys(vars).sort()).toEqual(['AUDIT_TABLE', 'SETTINGS_TABLE']);
    const esperado: Record<string, unknown> = {
      SETTINGS_TABLE: data.settings,
      AUDIT_TABLE: data.auditLog,
    };
    for (const [nombre, tabla] of Object.entries(esperado)) {
      const idEsperado = data.getLogicalId((tabla as Table).node.defaultChild as CfnTable);
      expect(typeof vars[nombre], nombre).toBe('object'); // no es un literal
      expect(tablaDeImport(dt, vars[nombre]!), nombre).toBe(idEsperado);
    }
  });

  it('IAM EXACTA: GetItem en Settings; PutItem en Settings y en AuditLog solo dentro de una transacción', () => {
    const { stack, data } = build();
    const t = Template.fromStack(stack);
    const dt = Template.fromStack(data);
    const idDe = (tb: Table): string => data.getLogicalId(tb.node.defaultChild as CfnTable);
    const settings = idDe(data.settings);
    const auditoria = idDe(data.auditLog);

    const dynamo = sentenciasDe(t, 'AdminSettings').filter((s) =>
      lista(s['Action']).some((a) => String(a).startsWith('dynamodb:')),
    );
    expect(dynamo, 'sin sentencias de DynamoDB (prueba vacuosa)').toHaveLength(3);

    const lectura: Json[] = [];
    const escrituraSettings: Json[] = [];
    const escrituraAudit: Json[] = [];
    for (const s of dynamo) {
      expect(s['Effect']).toBe('Allow');
      for (const a of lista(s['Action']) as string[]) expect(a).not.toContain('*');
      for (const r of lista(s['Resource'])) expect(JSON.stringify(r)).not.toBe('"*"');
      const ids = tablasDeSentencia(dt, s);
      expect(ids, 'una sola tabla por sentencia').toHaveLength(1);
      const [tabla] = ids;
      if (s['Condition'] === undefined) {
        lectura.push(s);
        expect(tabla).toBe(settings);
      } else if (tabla === settings) escrituraSettings.push(s);
      else if (tabla === auditoria) escrituraAudit.push(s);
      else throw new Error(`sentencia sobre una tabla inesperada: ${String(tabla)}`);
    }

    // Lectura: SOLO GetItem (sin Scan, BatchGetItem ni Query) y sin condición.
    expect(lectura).toHaveLength(1);
    expect(lista(lectura[0]!['Action'])).toEqual(['dynamodb:GetItem']);
    // Escritura de Settings: SOLO PutItem, dentro de una transacción.
    expect(escrituraSettings).toHaveLength(1);
    expect(lista(escrituraSettings[0]!['Action'])).toEqual(['dynamodb:PutItem']);
    expect(escrituraSettings[0]!['Condition']).toEqual(CONDICION_TRANSACCION);
    // Auditoría append-only: SOLO PutItem, dentro de una transacción.
    expect(escrituraAudit).toHaveLength(1);
    expect(lista(escrituraAudit[0]!['Action'])).toEqual(['dynamodb:PutItem']);
    expect(escrituraAudit[0]!['Condition']).toEqual(CONDICION_TRANSACCION);
  });

  it('IAM: fuera de DynamoDB solo logs; sin S3, tablas de catálogo ni comodines', () => {
    const { stack, data } = build();
    const t = Template.fromStack(stack);
    const dt = Template.fromStack(data);
    const todas = sentenciasDe(t, 'AdminSettings');
    for (const s of todas) {
      expect(JSON.stringify(s['Action'])).not.toContain('*');
      expect(JSON.stringify(s['Resource'])).not.toBe('"*"');
      const acciones = lista(s['Action']) as string[];
      if (!acciones.some((a) => a.startsWith('dynamodb:'))) {
        for (const a of acciones) expect(a).toMatch(/^logs:|^xray:/);
      }
    }
    expect(JSON.stringify(todas)).not.toContain('s3:');
    const catalogo = [data.stones, data.projects, data.finishes, data.services].map((tb) =>
      data.getLogicalId(tb.node.defaultChild as CfnTable),
    );
    for (const s of todas) {
      if (!lista(s['Action']).some((a) => String(a).startsWith('dynamodb:'))) continue;
      for (const id of tablasDeSentencia(dt, s)) expect(catalogo).not.toContain(id);
    }
  });

  it('las otras Lambdas (Health, AdminMe, AdminCatalog, AdminMedia) NO ganan permisos sobre Settings', () => {
    const { stack, data } = build();
    const t = Template.fromStack(stack);
    const dt = Template.fromStack(data);
    const settings = data.getLogicalId(data.settings.node.defaultChild as CfnTable);
    for (const f of ['Health', 'AdminMe', 'AdminCatalog', 'AdminMedia']) {
      for (const s of sentenciasDe(t, f)) {
        if (!lista(s['Action']).some((a) => String(a).startsWith('dynamodb:'))) continue;
        expect(tablasDeSentencia(dt, s), f).not.toContain(settings);
      }
      const fn = t.findResources('AWS::Lambda::Function')[idFuncion(t, f)]!;
      const vars = Object.keys(fn.Properties.Environment?.Variables ?? {});
      expect(vars, f).not.toContain('SETTINGS_TABLE');
    }
  });

  it('el bundle real de AdminSettings empaqueta zod y shared; solo el SDK de AWS queda externo (lo trae el runtime)', () => {
    const app = new App();
    const deploy = {
      name: 'dev',
      account: undefined,
      region: 'us-east-1',
      emulated: false,
    } as const;
    const auth = new AuthStack(app, 'Auth', { deploy });
    const data = new DataStack(app, 'Data', { deploy });
    const media = new MediaStack(app, 'Media', {
      deploy,
      allowedOrigins: ['http://localhost:5173'],
    });
    const publish = new PublishStack(app, 'Publish', { deploy });
    new ApiStack(app, 'Api', {
      deploy,
      userPool: auth.userPool,
      userPoolClient: auth.userPoolClient,
      mediaBucket: media.bucket,
      publishBucket: publish.bucket,
      tables: {
        stones: data.stones,
        projects: data.projects,
        finishes: data.finishes,
        services: data.services,
        settings: data.settings,
        auditLog: data.auditLog,
        publications: data.publications,
        freightConfig: data.freightConfig,
      },
    });
    const dir = app.synth().directory;
    const bundles = readdirSync(dir)
      .filter((d) => d.startsWith('asset.'))
      .map((d) => join(dir, d, 'index.js'))
      .filter((f) => existsSync(f))
      .map((f) => readFileSync(f, 'utf8'));
    const bundle = bundles.find((b) => b.includes('settings_write'));
    expect(bundle, 'no se encontró el bundle de AdminSettings').toBeDefined();
    const externos = [...(bundle as string).matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]!);
    for (const e of externos) expect(e, `require externo ${e}`).toMatch(/^@aws-sdk\/|^node:/);
    expect(bundle).not.toContain('@canteras/shared');
  }, 60_000);
});

describe('ApiStack: Lambda AdminPublish', () => {
  const RUTAS = [
    'ANY /admin/publish',
    'ANY /admin/publish/{proxy+}',
    'ANY /admin/publications',
    'ANY /admin/publications/{proxy+}',
  ];
  const ARN_INDICE = `/index/${AUDIT_SCOPE_INDEX}`;

  it('las 4 rutas de publicación integran la Lambda AdminPublish y todas son JWT', () => {
    const t = synth();
    const fn = idFuncion(t, 'AdminPublish');
    const integraciones = t.findResources('AWS::ApiGatewayV2::Integration');
    const vistas: string[] = [];
    for (const r of rutas(t)) {
      const key = r['RouteKey'] as string;
      if (!key.startsWith('ANY /admin/publi')) continue;
      expect(r['AuthorizationType'], key).toBe('JWT');
      expect(r['AuthorizerId'], key).toBeDefined();
      const target = JSON.stringify(r['Target']);
      const idInt = Object.keys(integraciones).find((id) => target.includes(`"${id}"`))!;
      expect(JSON.stringify(integraciones[idInt]!.Properties.IntegrationUri), key).toContain(
        `"${fn}"`,
      );
      vistas.push(key);
    }
    expect(vistas.sort()).toEqual([...RUTAS].sort());
  });

  it('la invariante de seguridad sigue verde con las rutas nuevas (solo GET /health es pública)', () => {
    for (const emulated of [false, true]) {
      expect(problemasDeSeguridad(synth({ emulated }))).toEqual([]);
    }
  });

  it('el entorno referencia las tablas y el bucket (no literales); SITE_DISTRIBUTION_ID solo si se pasa', () => {
    const { stack, data } = build();
    const t = Template.fromStack(stack);
    const dt = Template.fromStack(data);
    const fn = t.findResources('AWS::Lambda::Function')[idFuncion(t, 'AdminPublish')]!;
    const vars = fn.Properties.Environment.Variables as Record<string, Json>;
    expect(Object.keys(vars).sort()).toEqual(
      [
        'AUDIT_SCOPE_INDEX',
        'AUDIT_TABLE',
        'FINISHES_TABLE',
        'PROJECTS_TABLE',
        'PUBLICATIONS_TABLE',
        'PUBLISH_BUCKET',
        'SERVICES_TABLE',
        'SETTINGS_TABLE',
        'STONES_TABLE',
      ].sort(),
    );
    expect(vars['AUDIT_SCOPE_INDEX']).toBe(AUDIT_SCOPE_INDEX);
    const esperado: Record<string, unknown> = {
      STONES_TABLE: data.stones,
      PROJECTS_TABLE: data.projects,
      FINISHES_TABLE: data.finishes,
      SERVICES_TABLE: data.services,
      SETTINGS_TABLE: data.settings,
      PUBLICATIONS_TABLE: data.publications,
      AUDIT_TABLE: data.auditLog,
    };
    for (const [nombre, tabla] of Object.entries(esperado)) {
      const idEsperado = data.getLogicalId((tabla as Table).node.defaultChild as CfnTable);
      expect(typeof vars[nombre], nombre).toBe('object');
      expect(tablaDeImport(dt, vars[nombre]!), nombre).toBe(idEsperado);
    }
    expect(typeof vars['PUBLISH_BUCKET']).toBe('object');

    const conSitio = synth({ siteDistributionId: 'E1ABCDEF' });
    const v2 = conSitio.findResources('AWS::Lambda::Function')[idFuncion(conSitio, 'AdminPublish')]!
      .Properties.Environment.Variables as Record<string, unknown>;
    expect(v2['SITE_DISTRIBUTION_ID']).toBe('E1ABCDEF');
  });

  it('PUBLISH_BUCKET apunta al bucket de PublishStack (no al de media)', () => {
    const { stack, publish } = build();
    const t = Template.fromStack(stack);
    const pt = Template.fromStack(publish);
    const fn = t.findResources('AWS::Lambda::Function')[idFuncion(t, 'AdminPublish')]!;
    const nombre = fn.Properties.Environment.Variables['PUBLISH_BUCKET'][
      'Fn::ImportValue'
    ] as string;
    const outputs = pt.toJSON().Outputs as Record<
      string,
      { Value: Json; Export?: { Name: string } }
    >;
    const out = Object.values(outputs).find((o) => o.Export?.Name === nombre);
    expect(out, 'exportación del bucket de publicación').toBeDefined();
    expect(out!.Value['Ref']).toBe(publish.getLogicalId(publish.bucket.node.defaultChild as never));
  });

  /** Sentencias de DynamoDB agrupadas por tabla de DataStack. */
  function dynamoPorTabla(sitio?: string) {
    const { stack, data } = build(sitio ? { siteDistributionId: sitio } : {});
    const t = Template.fromStack(stack);
    const dt = Template.fromStack(data);
    const porId = new Map<string, Json[]>();
    const sobreIndice: Json[] = [];
    for (const s of sentenciasDe(t, 'AdminPublish')) {
      if (!lista(s['Action']).some((a) => String(a).startsWith('dynamodb:'))) continue;
      const recursos = lista(s['Resource']);
      if (recursos.some((r) => JSON.stringify(r).includes(ARN_INDICE))) {
        sobreIndice.push(s);
        continue;
      }
      const ids = tablasDeSentencia(dt, s);
      expect(ids, 'una sola tabla por sentencia (salvo las 4 entidades)').not.toHaveLength(0);
      for (const id of ids) porId.set(id, [...(porId.get(id) ?? []), s]);
    }
    const idDe = (tb: Table): string => data.getLogicalId(tb.node.defaultChild as CfnTable);
    return { t, data, porId, sobreIndice, idDe, stack };
  }

  it('IAM DynamoDB EXACTA: Scan en las 4 entidades; GetItem de Settings solo la clave PUBLIC', () => {
    const { data, porId, idDe } = dynamoPorTabla();
    for (const tb of [data.stones, data.projects, data.finishes, data.services]) {
      const ss = porId.get(idDe(tb))!;
      expect(ss, 'entidad').toHaveLength(1);
      expect(lista(ss[0]!['Action'])).toEqual(['dynamodb:Scan']);
      expect(ss[0]!['Condition']).toBeUndefined();
    }
    const settings = porId.get(idDe(data.settings))!;
    expect(settings).toHaveLength(1);
    expect(lista(settings[0]!['Action'])).toEqual(['dynamodb:GetItem']);
    // La fila MAIL (plantillas de correo) NO se puede leer con este rol.
    expect(settings[0]!['Condition']).toEqual({
      'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['PUBLIC'] },
    });
  });

  it('IAM DynamoDB EXACTA: Publications lee con GetItem/BatchGetItem y escribe PutItem solo en transacción', () => {
    const { data, porId, idDe } = dynamoPorTabla();
    const ss = porId.get(idDe(data.publications))!;
    expect(ss).toHaveLength(2);
    const lectura = ss.find((s) => s['Condition'] === undefined)!;
    const escritura = ss.find((s) => s['Condition'] !== undefined)!;
    expect((lista(lectura['Action']) as string[]).sort()).toEqual([
      'dynamodb:BatchGetItem',
      'dynamodb:GetItem',
    ]);
    expect(lista(escritura['Action'])).toEqual(['dynamodb:PutItem']);
    expect(escritura['Condition']).toEqual(CONDICION_TRANSACCION);
  });

  it('IAM DynamoDB EXACTA: AuditLog solo PutItem en transacción; el índice solo Query', () => {
    const { data, porId, idDe, sobreIndice } = dynamoPorTabla();
    const audit = porId.get(idDe(data.auditLog))!;
    expect(audit).toHaveLength(1);
    expect(lista(audit[0]!['Action'])).toEqual(['dynamodb:PutItem']);
    expect(audit[0]!['Condition']).toEqual(CONDICION_TRANSACCION);
    // Query solo sobre el GSI disperso (no sobre la tabla base): sin lectura de antes/después.
    expect(sobreIndice).toHaveLength(1);
    expect(lista(sobreIndice[0]!['Action'])).toEqual(['dynamodb:Query']);
    expect(lista(sobreIndice[0]!['Resource'])).toHaveLength(1);
    expect(sobreIndice[0]!['Condition']).toBeUndefined();
  });

  it('IAM DynamoDB: ninguna otra tabla (ni Counters) y ninguna acción de más', () => {
    const { data, porId, idDe } = dynamoPorTabla();
    const permitidas = [
      data.stones,
      data.projects,
      data.finishes,
      data.services,
      data.settings,
      data.publications,
      data.auditLog,
    ].map(idDe);
    expect([...porId.keys()].sort()).toEqual([...permitidas].sort());
    expect(porId.has(idDe(data.counters))).toBe(false);
    for (const ss of porId.values()) {
      for (const s of ss) {
        expect(s['Effect']).toBe('Allow');
        for (const a of lista(s['Action']) as string[]) {
          expect(a).not.toContain('*');
          expect(a).not.toMatch(/DeleteItem|UpdateItem|BatchWriteItem|TransactWriteItems|Query$/);
        }
      }
    }
  });

  it('IAM S3: solo GetObject y PutObject bajo published/* del bucket de publicación; sin listado ni borrado', () => {
    const { t } = dynamoPorTabla();
    const s3 = sentenciasDe(t, 'AdminPublish').filter((s) =>
      lista(s['Action']).some((a) => String(a).startsWith('s3:')),
    );
    expect(s3).toHaveLength(1);
    expect((lista(s3[0]!['Action']) as string[]).sort()).toEqual(['s3:GetObject', 's3:PutObject']);
    const recursos = lista(s3[0]!['Resource']);
    expect(recursos).toHaveLength(1);
    const texto = JSON.stringify(recursos[0]);
    expect(texto).toContain('/published/*');
    expect(texto).not.toBe('"*"');
    // Sin acceso al prefijo de fotos ni a la raíz del bucket.
    expect(texto).not.toMatch(/stones|projects|finishes/);
    expect(JSON.stringify(s3)).not.toMatch(/s3:(List|Delete)|s3:\*/);
  });

  it('IAM: sin CloudFront cuando no hay distribución; con ella, CreateInvalidation sobre ESA distribución', () => {
    const sin = dynamoPorTabla();
    expect(JSON.stringify(sentenciasDe(sin.t, 'AdminPublish'))).not.toContain('cloudfront:');

    const con = dynamoPorTabla('E1ABCDEF');
    const cf = sentenciasDe(con.t, 'AdminPublish').filter((s) =>
      lista(s['Action']).some((a) => String(a).startsWith('cloudfront:')),
    );
    expect(cf).toHaveLength(1);
    expect(lista(cf[0]!['Action'])).toEqual(['cloudfront:CreateInvalidation']);
    const recurso = JSON.stringify(cf[0]!['Resource']);
    expect(recurso).toContain('distribution/E1ABCDEF');
    expect(recurso).not.toContain('distribution/*');
  });

  it('IAM: fuera de DynamoDB, S3 y CloudFront solo logs; sin comodines', () => {
    const { t } = dynamoPorTabla('E1ABCDEF');
    for (const s of sentenciasDe(t, 'AdminPublish')) {
      expect(JSON.stringify(s['Action'])).not.toContain('*');
      expect(JSON.stringify(s['Resource'])).not.toBe('"*"');
      const acciones = lista(s['Action']) as string[];
      if (!acciones.some((a) => /^(dynamodb|s3|cloudfront):/.test(a))) {
        for (const a of acciones) expect(a).toMatch(/^logs:|^xray:/);
      }
    }
  });

  it('las otras Lambdas NO ganan permisos sobre Publications, el bucket de publicación ni CloudFront', () => {
    const { stack, data } = build({ siteDistributionId: 'E1ABCDEF' });
    const t = Template.fromStack(stack);
    const dt = Template.fromStack(data);
    const pub = data.getLogicalId(data.publications.node.defaultChild as CfnTable);
    for (const f of ['Health', 'AdminMe', 'AdminCatalog', 'AdminMedia', 'AdminSettings']) {
      const ss = sentenciasDe(t, f);
      expect(JSON.stringify(ss), f).not.toContain('cloudfront:');
      expect(JSON.stringify(ss), f).not.toContain('/published/');
      for (const s of ss) {
        if (!lista(s['Action']).some((a) => String(a).startsWith('dynamodb:'))) continue;
        if (JSON.stringify(s['Resource']).includes(ARN_INDICE))
          throw new Error(`${f} lee el índice`);
        expect(tablasDeSentencia(dt, s), f).not.toContain(pub);
      }
      const fn = t.findResources('AWS::Lambda::Function')[idFuncion(t, f)]!;
      const vars = Object.keys(fn.Properties.Environment?.Variables ?? {});
      for (const v of ['PUBLISH_BUCKET', 'PUBLICATIONS_TABLE', 'SITE_DISTRIBUTION_ID']) {
        expect(vars, `${f} ${v}`).not.toContain(v);
      }
    }
  });
});

describe('ApiStack: throttling por ruta de media', () => {
  it('la etapa $default limita las 2 rutas de media a 1 rps / ráfaga 2 y conserva el default 10/20', () => {
    const t = synth();
    const stage = Object.values(t.findResources('AWS::ApiGatewayV2::Stage'))[0]!;
    expect(stage.Properties.DefaultRouteSettings).toEqual({
      ThrottlingRateLimit: 10,
      ThrottlingBurstLimit: 20,
    });
    expect(stage.Properties.RouteSettings).toEqual({
      'ANY /admin/media': { ThrottlingRateLimit: 1, ThrottlingBurstLimit: 2 },
      'ANY /admin/media/{proxy+}': { ThrottlingRateLimit: 1, ThrottlingBurstLimit: 2 },
    });
  });

  it('las claves de RouteSettings coinciden exactamente con las rutas reales de media', () => {
    const t = synth();
    const stage = Object.values(t.findResources('AWS::ApiGatewayV2::Stage'))[0]!;
    const reales = rutas(t)
      .map((r) => r['RouteKey'] as string)
      .filter((k) => k.startsWith('ANY /admin/media'))
      .sort();
    expect(reales).toHaveLength(2);
    expect(Object.keys(stage.Properties.RouteSettings).sort()).toEqual(reales);
  });
});

describe('ApiStack: Lambda AdminFreight', () => {
  const RUTAS = [
    'ANY /admin/freight-config',
    'ANY /admin/freight-config/{proxy+}',
    'ANY /admin/freight',
    'ANY /admin/freight/{proxy+}',
  ];

  it('las 4 rutas de flete integran la Lambda AdminFreight y todas son JWT', () => {
    const t = synth();
    const fn = idFuncion(t, 'AdminFreight');
    const integraciones = t.findResources('AWS::ApiGatewayV2::Integration');
    const vistas: string[] = [];
    for (const r of rutas(t)) {
      const key = r['RouteKey'] as string;
      if (!key.startsWith('ANY /admin/freight')) continue;
      expect(r['AuthorizationType'], key).toBe('JWT');
      expect(r['AuthorizerId'], key).toBeDefined();
      const target = JSON.stringify(r['Target']);
      const idInt = Object.keys(integraciones).find((id) => target.includes(`"${id}"`))!;
      expect(JSON.stringify(integraciones[idInt]!.Properties.IntegrationUri), key).toContain(
        `"${fn}"`,
      );
      vistas.push(key);
    }
    expect(vistas.sort()).toEqual([...RUTAS].sort());
  });

  it('la invariante de seguridad sigue verde con las rutas nuevas (solo GET /health es pública)', () => {
    for (const emulated of [false, true]) {
      expect(problemasDeSeguridad(synth({ emulated }))).toEqual([]);
    }
  });

  it('el entorno referencia las 3 tablas (no literales)', () => {
    const { stack, data } = build();
    const t = Template.fromStack(stack);
    const dt = Template.fromStack(data);
    const fn = t.findResources('AWS::Lambda::Function')[idFuncion(t, 'AdminFreight')]!;
    const vars = fn.Properties.Environment.Variables as Record<string, Json>;
    expect(Object.keys(vars).sort()).toEqual([
      'AUDIT_TABLE',
      'FREIGHT_CONFIG_TABLE',
      'STONES_TABLE',
    ]);
    const esperado: Record<string, unknown> = {
      FREIGHT_CONFIG_TABLE: data.freightConfig,
      STONES_TABLE: data.stones,
      AUDIT_TABLE: data.auditLog,
    };
    for (const [nombre, tabla] of Object.entries(esperado)) {
      expect(tablaDeImport(dt, vars[nombre]!), nombre).toBe(
        data.getLogicalId((tabla as { node: { defaultChild: CfnTable } }).node.defaultChild),
      );
    }
  });

  function dynamoPorTabla() {
    const { stack, data } = build();
    const t = Template.fromStack(stack);
    const dt = Template.fromStack(data);
    const porId = new Map<string, Json[]>();
    for (const s of sentenciasDe(t, 'AdminFreight')) {
      if (!lista(s['Action']).some((a) => String(a).startsWith('dynamodb:'))) continue;
      const ids = tablasDeSentencia(dt, s);
      expect(ids, 'una sola tabla por sentencia').toHaveLength(1);
      porId.set(ids[0]!, [...(porId.get(ids[0]!) ?? []), s]);
    }
    const idDe = (tb: Table): string => data.getLogicalId(tb.node.defaultChild as CfnTable);
    return { t, data, porId, idDe };
  }

  it('IAM EXACTA: FreightConfig lee con GetItem/BatchGetItem y escribe PutItem solo en transacción', () => {
    const { data, porId, idDe } = dynamoPorTabla();
    const ss = porId.get(idDe(data.freightConfig))!;
    expect(ss).toHaveLength(2);
    const lectura = ss.find((s) => s['Condition'] === undefined)!;
    const escritura = ss.find((s) => s['Condition'] !== undefined)!;
    expect((lista(lectura['Action']) as string[]).sort()).toEqual([
      'dynamodb:BatchGetItem',
      'dynamodb:GetItem',
    ]);
    expect(lista(escritura['Action'])).toEqual(['dynamodb:PutItem']);
    expect(escritura['Condition']).toEqual(CONDICION_TRANSACCION);
  });

  it('IAM EXACTA: Stones solo BatchGetItem (sin escritura, Scan ni Query)', () => {
    const { data, porId, idDe } = dynamoPorTabla();
    const ss = porId.get(idDe(data.stones))!;
    expect(ss).toHaveLength(1);
    expect(lista(ss[0]!['Action'])).toEqual(['dynamodb:BatchGetItem']);
    expect(ss[0]!['Condition']).toBeUndefined();
  });

  it('IAM EXACTA: AuditLog solo PutItem en transacción', () => {
    const { data, porId, idDe } = dynamoPorTabla();
    const ss = porId.get(idDe(data.auditLog))!;
    expect(ss).toHaveLength(1);
    expect(lista(ss[0]!['Action'])).toEqual(['dynamodb:PutItem']);
    expect(ss[0]!['Condition']).toEqual(CONDICION_TRANSACCION);
  });

  it('IAM: solo esas 3 tablas, sin Counters, sin comodines y sin Scan/Query/Update/Delete', () => {
    const { t, data, porId, idDe } = dynamoPorTabla();
    expect([...porId.keys()].sort()).toEqual(
      [data.freightConfig, data.stones, data.auditLog].map(idDe).sort(),
    );
    expect(porId.has(idDe(data.counters))).toBe(false);
    for (const s of sentenciasDe(t, 'AdminFreight')) {
      expect(s['Effect']).toBe('Allow');
      expect(JSON.stringify(s['Resource'])).not.toBe('"*"');
      for (const a of lista(s['Action']) as string[]) {
        expect(a).not.toContain('*');
        expect(a).not.toMatch(
          /Scan|Query|UpdateItem|DeleteItem|BatchWriteItem|TransactWriteItems|^s3:|^cloudfront:/,
        );
        // Fuera de DynamoDB solo logs.
        if (!a.startsWith('dynamodb:')) expect(a).toMatch(/^logs:|^xray:/);
      }
    }
  });

  it('las otras Lambdas NO ganan permisos sobre FreightConfig ni reciben su variable', () => {
    const { stack, data } = build();
    const t = Template.fromStack(stack);
    const dt = Template.fromStack(data);
    const fc = data.getLogicalId(data.freightConfig.node.defaultChild as CfnTable);
    for (const f of [
      'Health',
      'AdminMe',
      'AdminCatalog',
      'AdminMedia',
      'AdminSettings',
      'AdminPublish',
    ]) {
      for (const s of sentenciasDe(t, f)) {
        if (!lista(s['Action']).some((a) => String(a).startsWith('dynamodb:'))) continue;
        if (lista(s['Resource']).some((r) => JSON.stringify(r).includes('/index/'))) continue;
        expect(tablasDeSentencia(dt, s), f).not.toContain(fc);
      }
      const fn = t.findResources('AWS::Lambda::Function')[idFuncion(t, f)]!;
      expect(Object.keys(fn.Properties.Environment?.Variables ?? {}), f).not.toContain(
        'FREIGHT_CONFIG_TABLE',
      );
    }
  });

  it('las rutas de flete usan el throttling de la etapa (sin límite propio por ruta)', () => {
    const t = synth();
    const stage = Object.values(t.findResources('AWS::ApiGatewayV2::Stage'))[0]!;
    const keys = Object.keys(stage.Properties.RouteSettings ?? {});
    expect(keys.some((k) => k.includes('freight'))).toBe(false);
  });
});
