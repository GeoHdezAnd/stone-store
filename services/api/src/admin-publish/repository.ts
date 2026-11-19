import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { SETTINGS_ROW_KEYS } from '@canteras/shared';
import type { AuditEntry } from '../lib/audit';

/** Clave de la fila puntero de la tabla Publications (la versión publicada vigente). */
export const CURRENT_KEY = 'CURRENT';

export type PublicationAction = 'publish' | 'revert';

export interface PublicationCounts {
  stones: number;
  finishes: number;
  projects: number;
  services: number;
}

/** Fila `v0001`, `v0002`...: INMUTABLE, nunca se reescribe ni se borra. */
export interface PublicationRow {
  version: string;
  action: PublicationAction;
  hash: string;
  /** Marca de tiempo (ISO) del contenido: corte para los «cambios pendientes». */
  generatedAt: string;
  publishedAt: string;
  publishedBy: string;
  s3Key: string;
  /** Solo en `revert`: versión cuyo contenido se republicó. */
  revertedFrom?: string;
  counts: PublicationCounts;
}

/** Fila puntero `CURRENT`: versión vigente (su `version` de tabla es siempre `CURRENT`). */
export interface CurrentRow {
  version: typeof CURRENT_KEY;
  currentVersion: string;
  action: PublicationAction;
  hash: string;
  generatedAt: string;
  publishedAt: string;
  publishedBy: string;
}

/** Entidades tal como están guardadas (sin validar: lo hace quien llama). */
export interface RawCatalog {
  stones: Record<string, unknown>[];
  projects: Record<string, unknown>[];
  finishes: Record<string, unknown>[];
  services: Record<string, unknown>[];
  /** Fila PUBLIC de Settings; `null` si no existe. La fila MAIL NUNCA se lee aquí. */
  publicSettings: Record<string, unknown> | null;
}

export interface PendingChange {
  entity: string;
  id: string;
  at: string;
  accion: string;
  userId: string;
}

export interface PendingPage {
  items: PendingChange[];
  /** `true` si hay más cambios que los devueltos. */
  truncated: boolean;
}

export interface CommitInput {
  /** `currentVersion` que se leyó (`null` = aún no había publicaciones). */
  baseVersion: string | null;
  publication: PublicationRow;
  audit: AuditEntry;
}

/** Otro publicó antes (condición fallida) o hay una transacción en conflicto: reintentable. */
export class ConflictError extends Error {
  constructor() {
    super('Conflicto con otra publicación en curso.');
    this.name = 'ConflictError';
  }
}

/**
 * Acceso a datos de la publicación. `commit` es ATÓMICO: fila `v<N>` (solo si no existe), fila
 * `CURRENT` (solo si sigue apuntando a `baseVersion`) y auditoría, juntas o ninguna.
 */
export interface PublishRepository {
  readCatalog(): Promise<RawCatalog>;
  getCurrent(): Promise<CurrentRow | null>;
  getPublication(version: string): Promise<PublicationRow | null>;
  /** Las filas de las versiones pedidas que existan, de la más nueva a la más vieja. */
  getPublications(versions: readonly string[]): Promise<PublicationRow[]>;
  /** Cambios del catálogo posteriores a `sinceExclusive` (ISO; `null` = todos), recientes primero. */
  listPending(sinceExclusive: string | null, limit: number): Promise<PendingPage>;
  commit(input: CommitInput): Promise<void>;
}

/** Lo mínimo que se usa de `DynamoDBDocumentClient` (se inyecta para poder probar sin AWS). */
export interface DocClient {
  send(command: unknown): Promise<unknown>;
}

export interface PublishTables {
  stones: string;
  projects: string;
  finishes: string;
  services: string;
  settings: string;
  publications: string;
  auditLog: string;
  /** Nombre del GSI disperso de AuditLog (`scope` + `sk`). */
  auditScopeIndex: string;
}

export interface DynamoPublishOptions {
  sleep?: (ms: number) => Promise<void>;
}

const AUDIT_CONDITION = 'attribute_not_exists(pk) AND attribute_not_exists(sk)';
// Tope de páginas de un Scan: las tablas del catálogo son chicas; si se pasa, algo anda mal.
const MAX_SCAN_PAGES = 50;
const MAX_BATCH_ATTEMPTS = 5;

export class DynamoPublishRepository implements PublishRepository {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly client: DocClient,
    private readonly tables: PublishTables,
    options: DynamoPublishOptions = {},
  ) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private async scanAll(table: string): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let startKey: Record<string, unknown> | undefined;
    for (let page = 0; page < MAX_SCAN_PAGES; page++) {
      const out = (await this.client.send(
        new ScanCommand({
          TableName: table,
          ConsistentRead: true,
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      )) as { Items?: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> };
      items.push(...(out.Items ?? []));
      if (out.LastEvaluatedKey === undefined) return items;
      startKey = out.LastEvaluatedKey;
    }
    throw new Error('El Scan superó el tope de páginas.');
  }

  async readCatalog(): Promise<RawCatalog> {
    const [stones, projects, finishes, services, settings] = await Promise.all([
      this.scanAll(this.tables.stones),
      this.scanAll(this.tables.projects),
      this.scanAll(this.tables.finishes),
      this.scanAll(this.tables.services),
      // Solo la fila PUBLIC: la MAIL (plantillas) no se lee ni se publica.
      this.client.send(
        new GetCommand({
          TableName: this.tables.settings,
          Key: { key: SETTINGS_ROW_KEYS.public },
          ConsistentRead: true,
        }),
      ) as Promise<{ Item?: Record<string, unknown> }>,
    ]);
    return { stones, projects, finishes, services, publicSettings: settings.Item ?? null };
  }

  async getCurrent(): Promise<CurrentRow | null> {
    const out = (await this.client.send(
      new GetCommand({
        TableName: this.tables.publications,
        Key: { version: CURRENT_KEY },
        ConsistentRead: true,
      }),
    )) as { Item?: CurrentRow };
    return out.Item ?? null;
  }

  async getPublication(version: string): Promise<PublicationRow | null> {
    const out = (await this.client.send(
      new GetCommand({
        TableName: this.tables.publications,
        Key: { version },
        ConsistentRead: true,
      }),
    )) as { Item?: PublicationRow };
    return out.Item ?? null;
  }

  async getPublications(versions: readonly string[]): Promise<PublicationRow[]> {
    const unique = [...new Set(versions)];
    if (unique.length === 0) return [];
    const table = this.tables.publications;
    const found: PublicationRow[] = [];
    let keys: Record<string, unknown>[] = unique.map((version) => ({ version }));
    for (let attempt = 0; keys.length > 0; attempt++) {
      if (attempt >= MAX_BATCH_ATTEMPTS) {
        throw new Error('BatchGetItem no resolvió todas las UnprocessedKeys.');
      }
      if (attempt > 0) await this.sleep(Math.min(50 * 2 ** attempt, 1000));
      const out = (await this.client.send(
        new BatchGetCommand({ RequestItems: { [table]: { Keys: keys, ConsistentRead: true } } }),
      )) as {
        Responses?: Record<string, PublicationRow[]>;
        UnprocessedKeys?: Record<string, { Keys?: Record<string, unknown>[] }>;
      };
      found.push(...(out.Responses?.[table] ?? []));
      keys = out.UnprocessedKeys?.[table]?.Keys ?? [];
    }
    return found.sort((a, b) => (a.version < b.version ? 1 : a.version > b.version ? -1 : 0));
  }

  async listPending(sinceExclusive: string | null, limit: number): Promise<PendingPage> {
    // Query al GSI disperso: solo existen los ítems con `scope = "CATALOG"`. Consistencia
    // eventual (los GSI no admiten lecturas fuertes): un cambio recién hecho puede tardar
    // un instante en aparecer. La proyección del índice NO incluye `antes`/`despues`.
    const out = (await this.client.send(
      new QueryCommand({
        TableName: this.tables.auditLog,
        IndexName: this.tables.auditScopeIndex,
        KeyConditionExpression:
          sinceExclusive === null ? '#scope = :scope' : '#scope = :scope AND #sk > :since',
        ExpressionAttributeNames: {
          '#scope': 'scope',
          ...(sinceExclusive === null ? {} : { '#sk': 'sk' }),
        },
        ExpressionAttributeValues: {
          ':scope': 'CATALOG',
          ...(sinceExclusive === null ? {} : { ':since': sinceExclusive }),
        },
        ScanIndexForward: false,
        Limit: limit + 1,
      }),
    )) as { Items?: Record<string, unknown>[] };
    const rows = out.Items ?? [];
    const items: PendingChange[] = [];
    for (const row of rows.slice(0, limit)) {
      const parsed = parsePendingRow(row);
      if (parsed !== null) items.push(parsed);
    }
    return { items, truncated: rows.length > limit };
  }

  async commit(input: CommitInput): Promise<void> {
    const { baseVersion, publication, audit } = input;
    const current: CurrentRow = {
      version: CURRENT_KEY,
      currentVersion: publication.version,
      action: publication.action,
      hash: publication.hash,
      generatedAt: publication.generatedAt,
      publishedAt: publication.publishedAt,
      publishedBy: publication.publishedBy,
    };
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tables.publications,
                Item: publication,
                ConditionExpression: 'attribute_not_exists(#v)',
                ExpressionAttributeNames: { '#v': 'version' },
              },
            },
            {
              Put: {
                TableName: this.tables.publications,
                Item: current,
                ...(baseVersion === null
                  ? {
                      ConditionExpression: 'attribute_not_exists(#v)',
                      ExpressionAttributeNames: { '#v': 'version' },
                    }
                  : {
                      ConditionExpression: '#cv = :base',
                      ExpressionAttributeNames: { '#cv': 'currentVersion' },
                      ExpressionAttributeValues: { ':base': baseVersion },
                    }),
              },
            },
            {
              Put: {
                TableName: this.tables.auditLog,
                Item: audit,
                ConditionExpression: AUDIT_CONDITION,
              },
            },
          ],
        }),
      );
    } catch (err) {
      if (isConflict(err)) throw new ConflictError();
      throw err;
    }
  }
}

function parsePendingRow(row: Record<string, unknown>): PendingChange | null {
  const { pk, sk, accion, userId } = row;
  if (
    typeof pk !== 'string' ||
    typeof sk !== 'string' ||
    typeof accion !== 'string' ||
    typeof userId !== 'string'
  ) {
    return null;
  }
  const [prefix, entity, ...idParts] = pk.split('#');
  if (prefix !== 'ENTITY' || entity === undefined || idParts.length === 0) return null;
  const at = sk.split('#')[0] ?? '';
  return { entity, id: idParts.join('#'), at, accion, userId };
}

/**
 * Conflicto de dominio: la condición de la fila `v<N>` o de `CURRENT` falló (índices 0 y 1) o hay
 * una transacción en curso. Un fallo de la auditoría (índice 2) NO lo es: se propaga.
 */
function isConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; CancellationReasons?: unknown };
  if (e.name !== 'TransactionCanceledException' || !Array.isArray(e.CancellationReasons)) {
    return false;
  }
  const reasons = e.CancellationReasons as { Code?: string }[];
  return reasons.some(
    (r, i) => r.Code === 'TransactionConflict' || (i < 2 && r.Code === 'ConditionalCheckFailed'),
  );
}
