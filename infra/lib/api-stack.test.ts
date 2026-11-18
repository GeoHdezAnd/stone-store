import { existsSync } from 'node:fs';
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
import { DataStack } from './data-stack.js';

const REPO = join(import.meta.dirname, '..', '..');

interface BuildOptions {
  name?: 'dev' | 'prod';
  emulated?: boolean;
  allowedOrigins?: string[];
}

function build(opts: BuildOptions = {}): { stack: ApiStack; auth: AuthStack; data: DataStack } {
  const { name = 'dev', emulated = false, allowedOrigins } = opts;
  // Se omite el bundling con esbuild para que la síntesis sea rápida; el synth real de
  // `cdk synth` sí empaqueta.
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const deploy = { name, account: undefined, region: 'us-east-1', emulated } as const;
  const auth = new AuthStack(app, 'Auth', { deploy });
  const data = new DataStack(app, 'Data', { deploy });
  const stack = new ApiStack(app, 'Api', {
    deploy,
    userPool: auth.userPool,
    userPoolClient: auth.userPoolClient,
    tables: {
      stones: data.stones,
      projects: data.projects,
      finishes: data.finishes,
      services: data.services,
      auditLog: data.auditLog,
    },
    ...(allowedOrigins ? { allowedOrigins } : {}),
  });
  Tags.of(app).add('Project', 'canteras-naturales');
  Tags.of(app).add('Env', name);
  return { stack, auth, data };
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
        'ANY /admin/me',
        'ANY /admin/me/{proxy+}',
        'ANY /admin/projects',
        'ANY /admin/projects/{proxy+}',
        'ANY /admin/services',
        'ANY /admin/services/{proxy+}',
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
    ]) {
      expect(existsSync(join(REPO, p)), p).toBe(true);
    }
  });

  it('hay 3 funciones nodejs22.x, 256 MB, 10 s, handler `handler`', () => {
    const t = synth();
    t.resourceCountIs('AWS::Lambda::Function', 3);
    t.allResourcesProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      MemorySize: 256,
      Timeout: 10,
      Handler: Match.stringLikeRegexp('handler$'),
    });
  });

  it('cada función tiene su log group con retención de 1 semana (sin logRetention)', () => {
    const t = synth();
    t.resourceCountIs('AWS::Logs::LogGroup', 3);
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
    id.includes(fragmento),
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
    for (const f of ['Health', 'AdminMe']) {
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
    // Cada una de las 3 funciones tiene al menos un permiso.
    const fns = Object.keys(t.findResources('AWS::Lambda::Function'));
    for (const f of fns) {
      expect(
        permisos.some((p) => JSON.stringify(p['FunctionName']).includes(`"${f}"`)),
        f,
      ).toBe(true);
    }
  });
});
