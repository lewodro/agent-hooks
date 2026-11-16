import { randomUUID } from "node:crypto";

import type { DedupeStore } from "./index.js";

/** Driver-neutral subset implemented by PostgreSQL pools and clients. */
export interface TriggerPostgreSqlExecutor {
  query(
    statement: string,
    parameters?: unknown[],
  ): Promise<{ rows: readonly Record<string, unknown>[] }>;
}

export interface PostgresDedupeStoreOptions {
  /** How long an interrupted dispatcher may hold an incomplete claim. Defaults to five minutes. */
  leaseMilliseconds?: number;
  now?: () => Date;
}

/**
 * PostgreSQL-backed trigger claims. Successful deliveries remain claimed until
 * retention cleanup; interrupted deliveries become claimable after the lease.
 */
export class PostgresDedupeStore implements DedupeStore {
  private readonly leaseMilliseconds: number;
  private readonly now: () => Date;
  private readonly legacyTokens = new Map<string, string[]>();

  constructor(private readonly db: TriggerPostgreSqlExecutor, options: PostgresDedupeStoreOptions = {}) {
    this.leaseMilliseconds = options.leaseMilliseconds ?? 5 * 60_000;
    this.now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.leaseMilliseconds) || this.leaseMilliseconds < 1 || this.leaseMilliseconds > 86_400_000) {
      throw new RangeError("trigger claim lease must be between 1 ms and 24 hours");
    }
  }

  /** Apply the additive claim schema from a controlled migration step. */
  async initialize(): Promise<void> {
    await this.db.query(`CREATE TABLE IF NOT EXISTS agent_hook_trigger_claims (
      claim_key TEXT PRIMARY KEY CHECK (char_length(claim_key) BETWEEN 1 AND 1024),
      lease_token UUID NOT NULL,
      lease_expires_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ
    )`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS agent_hook_trigger_claims_expiry_idx
      ON agent_hook_trigger_claims (lease_expires_at) WHERE completed_at IS NULL`);
  }

  /** Compatibility method for existing DedupeStore callers. */
  async claim(key: string): Promise<boolean> {
    const token = await this.acquire(key);
    if (!token) return false;
    const tokens = this.legacyTokens.get(key) ?? [];
    tokens.push(token);
    this.legacyTokens.set(key, tokens);
    return true;
  }

  /** Atomically create a lease or reclaim one left incomplete past its expiry. */
  async acquire(key: string): Promise<string | undefined> {
    validateClaimKey(key);
    const now = this.now();
    if (!Number.isFinite(now.getTime())) throw new TypeError("trigger claim clock must return a valid date");
    const token = randomUUID();
    const expiry = new Date(now.getTime() + this.leaseMilliseconds);
    const result = await this.db.query(
      `INSERT INTO agent_hook_trigger_claims (claim_key, lease_token, lease_expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (claim_key) DO UPDATE SET
         lease_token = EXCLUDED.lease_token,
         lease_expires_at = EXCLUDED.lease_expires_at
       WHERE agent_hook_trigger_claims.completed_at IS NULL
         AND agent_hook_trigger_claims.lease_expires_at <= $4
       RETURNING lease_token`,
      [key, token, expiry, now],
    );
    return result.rows.length > 0 ? token : undefined;
  }

  /** Mark a delivered wake permanent so ordinary restarts cannot re-deliver it. */
  async complete(key: string, token: string): Promise<void> {
    validateClaimKey(key);
    await this.db.query(
      `UPDATE agent_hook_trigger_claims SET completed_at = $3
       WHERE claim_key = $1 AND lease_token = $2 AND completed_at IS NULL`,
      [key, token, this.now()],
    );
  }

  /** Release only the lease owned by this delivery attempt. */
  async releaseClaim(key: string, token: string): Promise<void> {
    validateClaimKey(key);
    await this.db.query(
      `DELETE FROM agent_hook_trigger_claims WHERE claim_key = $1 AND lease_token = $2 AND completed_at IS NULL`,
      [key, token],
    );
  }

  /**
   * Delete completed records and abandoned leases older than an explicit cutoff.
   * Choose a retention horizon longer than the source's replay/backfill window.
   */
  async pruneRetained(before: Date, limit = 500): Promise<number> {
    if (!Number.isFinite(before.getTime())) throw new TypeError("trigger claim retention cutoff must be a valid date");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new RangeError("trigger claim prune limit must be between 1 and 10000");
    }
    const result = await this.db.query(
      `WITH old_claims AS (
        SELECT claim_key FROM agent_hook_trigger_claims
        WHERE (completed_at IS NOT NULL AND completed_at <= $1)
          OR (completed_at IS NULL AND lease_expires_at <= $1)
        ORDER BY COALESCE(completed_at, lease_expires_at) ASC
        LIMIT $2
      ) DELETE FROM agent_hook_trigger_claims AS claims
        USING old_claims WHERE claims.claim_key = old_claims.claim_key
        RETURNING claims.claim_key`,
      [before, limit],
    );
    return result.rows.length;
  }

  /** Compatibility release; TriggerEngine uses token-fenced releaseClaim when available. */
  async release(key: string): Promise<void> {
    const tokens = this.legacyTokens.get(key);
    const token = tokens?.shift();
    if (tokens?.length === 0) this.legacyTokens.delete(key);
    if (token) await this.releaseClaim(key, token);
  }
}

function validateClaimKey(key: string): void {
  if (typeof key !== "string" || key.length < 1 || key.length > 1024) {
    throw new RangeError("trigger claim key must contain 1-1024 characters");
  }
}
