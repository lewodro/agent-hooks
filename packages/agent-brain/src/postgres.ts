import { createHash } from "node:crypto";

import {
  ExperienceIdConflictError,
  validateExperience,
  type Experience,
  type ExperienceQuery,
  type ExperienceStore,
} from "./memory.js";

/** Minimal SQL driver contract; compatible with common PostgreSQL pool/client query methods. */
export interface PostgreSqlExecutor {
  query(
    statement: string,
    parameters?: unknown[],
  ): Promise<{ rows: readonly Record<string, unknown>[] }>;
}

const TABLE = "agent_hook_experiences";

/**
 * PostgreSQL-backed append-only experience storage. Supply a configured pool or
 * client from the host application; this package never reads connection secrets.
 */
export class PostgresExperienceStore implements ExperienceStore {
  constructor(private readonly db: PostgreSqlExecutor) {}

  /** Apply the small additive schema and indexes. Call from a controlled migration step. */
  async initialize(): Promise<void> {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        experience_id TEXT PRIMARY KEY,
        record_hash CHAR(64) NOT NULL,
        schema_version SMALLINT NOT NULL CHECK (schema_version = 1),
        observed_at TIMESTAMPTZ NOT NULL,
        adapter TEXT NOT NULL,
        event_kind TEXT NOT NULL,
        composition_id TEXT NOT NULL,
        evidence_channel TEXT NOT NULL,
        evidence_status TEXT NOT NULL,
        payload JSONB NOT NULL
      )
    `);
    await this.db.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_observed_idx ON ${TABLE} (observed_at DESC, experience_id)`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_event_idx ON ${TABLE} (adapter, event_kind, observed_at DESC)`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_composition_idx ON ${TABLE} (composition_id, observed_at DESC)`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_outcome_idx ON ${TABLE} ((payload #>> '{feedback,outcome}'), observed_at DESC)`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_hook_ids_idx ON ${TABLE} USING GIN ((payload #> '{feedback,hookProgramIds}'))`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_tags_idx ON ${TABLE} USING GIN ((payload -> 'tags'))`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_evidence_idx ON ${TABLE} (evidence_channel, evidence_status, observed_at DESC)`);
  }

  async append(experience: Experience): Promise<void> {
    validateExperience(experience);
    const payload = canonicalJson(experience);
    const hash = createHash("sha256").update(payload).digest("hex");
    const inserted = await this.db.query(
      `INSERT INTO ${TABLE} (
        experience_id, record_hash, schema_version, observed_at, adapter,
        event_kind, composition_id, evidence_channel, evidence_status, payload
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
      ON CONFLICT (experience_id) DO NOTHING
      RETURNING experience_id`,
      [
        experience.id,
        hash,
        experience.schemaVersion,
        experience.observedAt,
        experience.event.adapter,
        experience.event.kind,
        experience.feedback.compositionId,
        experience.evidence.channel,
        experience.evidence.status,
        payload,
      ],
    );
    if (inserted.rows.length > 0) return;

    const existing = await this.db.query(
      `SELECT record_hash FROM ${TABLE} WHERE experience_id = $1`,
      [experience.id],
    );
    const existingHash = existing.rows[0]?.record_hash;
    if (typeof existingHash !== "string") {
      throw new Error(`Experience ${experience.id} conflicted on insert but could not be read back`);
    }
    if (existingHash.trim() !== hash) throw new ExperienceIdConflictError(experience.id);
  }

  async query(query: ExperienceQuery): Promise<Experience[]> {
    const where: string[] = ["schema_version = 1"];
    const parameters: unknown[] = [];
    const addFilter = (column: string, value: string | undefined): void => {
      if (value === undefined) return;
      parameters.push(value);
      where.push(`${column} = $${parameters.length}`);
    };
    addFilter("adapter", query.adapter);
    addFilter("event_kind", query.kind);
    addFilter("composition_id", query.compositionId);
    addFilter("payload #>> '{feedback,outcome}'", query.outcome);
    const addJsonMembershipFilter = (expression: string, value: string | undefined): void => {
      if (value === undefined) return;
      parameters.push(value);
      where.push(`(${expression}) ? $${parameters.length}`);
    };
    addJsonMembershipFilter("payload #> '{feedback,hookProgramIds}'", query.hookProgramId);
    addJsonMembershipFilter("payload -> 'tags'", query.tag);
    const since = query.since === undefined ? undefined : Date.parse(query.since);
    const until = query.until === undefined ? undefined : Date.parse(query.until);
    if (since !== undefined && !Number.isFinite(since)) throw new TypeError("query since must be a valid date string");
    if (until !== undefined && !Number.isFinite(until)) throw new TypeError("query until must be a valid date string");
    if (since !== undefined && until !== undefined && since > until) {
      throw new RangeError("query since must be earlier than or equal to until");
    }
    if (query.since !== undefined) {
      parameters.push(new Date(since!).toISOString());
      where.push(`observed_at >= $${parameters.length}`);
    }
    if (query.until !== undefined) {
      parameters.push(new Date(until!).toISOString());
      where.push(`observed_at <= $${parameters.length}`);
    }
    if (query.verifiedOnly) {
      where.push("evidence_channel = 'chain'");
      where.push("evidence_status IN ('confirmed', 'finalized')");
      where.push("NULLIF(BTRIM(payload #>> '{evidence,network}'), '') IS NOT NULL");
      where.push("NULLIF(BTRIM(payload #>> '{evidence,transactionId}'), '') IS NOT NULL");
      where.push(`(
        CASE WHEN payload #>> '{evidence,slot}' ~ '^[0-9]+$'
          THEN (payload #>> '{evidence,slot}')::numeric <= 9007199254740991 ELSE FALSE END OR
        CASE WHEN payload #>> '{evidence,blockHeight}' ~ '^[0-9]+$'
          THEN (payload #>> '{evidence,blockHeight}')::numeric <= 9007199254740991 ELSE FALSE END
      )`);
    }
    const requestedLimit = query.limit ?? 20;
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 200)
      : 20;
    parameters.push(limit);
    const result = await this.db.query(
      `SELECT payload FROM ${TABLE} WHERE ${where.join(" AND ")}
       ORDER BY observed_at DESC, experience_id ASC LIMIT $${parameters.length}`,
      parameters,
    );
    return result.rows.map((row) => decodeExperience(row.payload));
  }
}

function canonicalJson(experience: Experience): string {
  // JSON has no bigint primitive. Preserve the SDK's fixed-point oracle values
  // as decimal strings in PostgreSQL and restore them at the store boundary.
  const serializable = {
    ...experience,
    event: {
      ...experience.event,
      market: {
        ...experience.event.market,
        oraclePoints: experience.event.market.oraclePoints.map((point) => ({
          ...point,
          priceE8: point.priceE8.toString(),
          confidenceE8: point.confidenceE8.toString(),
          slot: point.slot.toString(),
        })),
      },
    },
  };
  return JSON.stringify(sortJsonKeys(serializable));
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sortJsonKeys(item)]),
    );
  }
  return value;
}

function decodeExperience(value: unknown): Experience {
  const decoded = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new TypeError("PostgreSQL experience payload is not an object");
  }
  const experience = decoded as Experience & {
    event: Omit<Experience["event"], "market"> & {
      market: Omit<Experience["event"]["market"], "oraclePoints"> & {
        oraclePoints: Array<{
          mint: string;
          priceE8: string;
          confidenceE8: string;
          slot: string;
        }>;
      };
    };
  };
  if (experience.schemaVersion !== 1 || typeof experience.id !== "string" ||
    !experience.event || typeof experience.event !== "object" ||
    !experience.event.market || typeof experience.event.market !== "object" ||
    !Array.isArray(experience.event.market.oraclePoints) ||
    !experience.feedback || !experience.evidence || !Array.isArray(experience.trace) ||
    !Array.isArray(experience.tags)) {
    throw new TypeError("PostgreSQL experience payload does not match schema version 1");
  }
  let restored: Experience;
  try {
    restored = {
      ...experience,
      event: {
        ...experience.event,
        market: {
          ...experience.event.market,
          oraclePoints: experience.event.market.oraclePoints.map((point) => ({
            ...point,
            priceE8: parseUnsignedBigInt(point.priceE8, "priceE8"),
            confidenceE8: parseUnsignedBigInt(point.confidenceE8, "confidenceE8"),
            slot: parseUnsignedBigInt(point.slot, "oracle slot"),
          })),
        },
      },
    } as Experience;
  } catch (error) {
    if (error instanceof TypeError) {
      throw new TypeError(`PostgreSQL experience payload has invalid oracle integers: ${error.message}`);
    }
    throw error;
  }
  validateExperience(restored);
  return restored;
}

function parseUnsignedBigInt(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${field} must be a non-negative decimal string`);
  }
  return BigInt(value);
}
