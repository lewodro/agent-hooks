import { createHmac, timingSafeEqual } from "node:crypto";
import { Connection, PublicKey, type Finality, type Logs } from "@solana/web3.js";
import type { LifecycleEvent, LifecycleEventKind } from "@agent-hooks/contracts";

export { createOpenClawDispatcher, formatWakeText } from "./openclaw.js";
export type { OpenClawDispatcherOptions } from "./openclaw.js";
export { createHermesDispatcher, toHermesPayload } from "./hermes.js";
export type { HermesDispatcherOptions } from "./hermes.js";
export { createWebhookDispatcher } from "./webhook.js";
export type { WebhookDispatcherOptions } from "./webhook.js";

export interface ChainObservation {
  chain: "solana";
  source: "rpc-logs" | "webhook";
  sourceId: string;
  signature: string;
  slot: bigint;
  blockTime: number | null;
  programId: string;
  logs?: readonly string[];
  event?: LifecycleEvent;
  sourceVerified: boolean;
  receivedAt: string;
}

export interface TriggerPredicate {
  programIds?: readonly string[];
  signatures?: readonly string[];
  eventKinds?: readonly LifecycleEventKind[];
  adapters?: readonly LifecycleEvent["adapter"][];
  minLtvBps?: number;
  maxLtvBps?: number;
}

export interface TriggerDefinition {
  id: string;
  predicate: TriggerPredicate;
  enabled?: boolean;
}

export interface WakeRequest {
  trigger: TriggerDefinition;
  observation: ChainObservation;
  dedupeKey: string;
}

export interface WakeDispatcher {
  wake(request: WakeRequest): Promise<void>;
}

export interface DedupeStore {
  claim(key: string): Promise<boolean>;
}

export class MemoryDedupeStore implements DedupeStore {
  private readonly keys = new Set<string>();

  async claim(key: string): Promise<boolean> {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    return true;
  }
}

export interface TriggerEngineOptions {
  triggers: readonly TriggerDefinition[];
  dispatcher: WakeDispatcher;
  dedupe?: DedupeStore;
  now?: () => Date;
}

/** Matches verified observations and wakes an off-chain worker at-least-once. */
export class TriggerEngine {
  private readonly dedupe: DedupeStore;
  private readonly now: () => Date;

  constructor(private readonly options: TriggerEngineOptions) {
    this.dedupe = options.dedupe ?? new MemoryDedupeStore();
    this.now = options.now ?? (() => new Date());
  }

  async ingest(observation: ChainObservation): Promise<readonly WakeRequest[]> {
    if (!observation.sourceVerified) throw new Error("cannot ingest an unverified chain observation");
    const requests: WakeRequest[] = [];
    for (const trigger of this.options.triggers) {
      if (trigger.enabled === false || !matches(trigger.predicate, observation)) continue;
      const dedupeKey = `${trigger.id}:${observation.signature}:${observation.sourceId}`;
      if (!(await this.dedupe.claim(dedupeKey))) continue;
      const request = { trigger, observation, dedupeKey } satisfies WakeRequest;
      await this.options.dispatcher.wake(request);
      requests.push(request);
    }
    return requests;
  }

  /** Useful for tests and adapters that need a deterministic receive timestamp. */
  receivedAt(): string {
    return this.now().toISOString();
  }
}

function matches(predicate: TriggerPredicate, observation: ChainObservation): boolean {
  if (predicate.programIds && !predicate.programIds.includes(observation.programId)) return false;
  if (predicate.signatures && !predicate.signatures.includes(observation.signature)) return false;
  const event = observation.event;
  if (predicate.eventKinds && (!event || !predicate.eventKinds.includes(event.kind))) return false;
  if (predicate.adapters && (!event || !predicate.adapters.includes(event.adapter))) return false;
  if (predicate.minLtvBps !== undefined && (!event || event.position.ltvBps < predicate.minLtvBps)) return false;
  if (predicate.maxLtvBps !== undefined && (!event || event.position.ltvBps > predicate.maxLtvBps)) return false;
  return true;
}

export interface RpcLogSourceOptions {
  connection: Connection;
  programId: PublicKey;
  commitment?: Finality;
  onObservation: (observation: ChainObservation) => Promise<void>;
}

/** RPC log source. It authenticates the subscribed program, but does not decode protocol events. */
export class SolanaLogSource {
  private subscriptionId: number | undefined;

  constructor(private readonly options: RpcLogSourceOptions) {}

  async start(): Promise<number> {
    if (this.subscriptionId !== undefined) return this.subscriptionId;
    this.subscriptionId = this.options.connection.onLogs(
      this.options.programId,
      (logs: Logs) => {
        void this.handle(logs);
      },
      this.options.commitment ?? "confirmed",
    );
    return this.subscriptionId;
  }

  async stop(): Promise<void> {
    if (this.subscriptionId === undefined) return;
    await this.options.connection.removeOnLogsListener(this.subscriptionId);
    this.subscriptionId = undefined;
  }

  private async handle(logs: Logs): Promise<void> {
    const slot = await this.options.connection.getTransaction(logs.signature, {
      commitment: this.options.commitment ?? "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    await this.options.onObservation({
      chain: "solana",
      source: "rpc-logs",
      sourceId: logs.signature,
      signature: logs.signature,
      slot: BigInt(slot?.slot ?? 0),
      blockTime: slot?.blockTime ?? null,
      programId: this.options.programId.toBase58(),
      logs: logs.logs,
      sourceVerified: logs.err === null && slot !== null,
      receivedAt: new Date().toISOString(),
    });
  }
}

export interface SignedWebhookOptions {
  secret: string;
  maxAgeSeconds?: number;
  nowSeconds?: () => number;
}

/** Verifies `sha256=<hex>` over `${timestamp}.${body}` before JSON parsing. */
export function verifySignedWebhook(
  body: string,
  signature: string,
  timestamp: string,
  options: SignedWebhookOptions,
): boolean {
  const timestampSeconds = Number(timestamp);
  const now = options.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
  const maxAge = options.maxAgeSeconds ?? 300;
  if (!Number.isInteger(timestampSeconds) || Math.abs(now - timestampSeconds) > maxAge) return false;
  const expected = `sha256=${createHmac("sha256", options.secret).update(`${timestamp}.${body}`).digest("hex")}`;
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function parseSignedWebhook(
  body: string,
  headers: { signature?: string; timestamp?: string },
  options: SignedWebhookOptions,
): ChainObservation {
  if (!headers.signature || !headers.timestamp || !verifySignedWebhook(body, headers.signature, headers.timestamp, options)) {
    throw new Error("invalid or expired webhook signature");
  }
  const parsed = JSON.parse(body) as Record<string, unknown>;
  if (parsed.chain !== "solana" || parsed.source !== "webhook" || typeof parsed.signature !== "string") {
    throw new Error("webhook payload is not a valid Solana observation");
  }
  if (typeof parsed.sourceId !== "string" || typeof parsed.programId !== "string" || typeof parsed.receivedAt !== "string") {
    throw new Error("webhook payload is missing observation identifiers");
  }
  const slot = exactInteger(parsed.slot, "slot");
  return {
    chain: "solana",
    source: "webhook",
    sourceId: parsed.sourceId,
    signature: parsed.signature,
    slot,
    blockTime: typeof parsed.blockTime === "number" ? parsed.blockTime : null,
    programId: parsed.programId,
    sourceVerified: true,
    receivedAt: parsed.receivedAt,
    ...(Array.isArray(parsed.logs) ? { logs: parsed.logs.filter((item): item is string => typeof item === "string") } : {}),
    ...(parsed.event ? { event: decodeLifecycleEvent(parsed.event) } : {}),
  };
}

function exactInteger(value: unknown, label: string): bigint {
  if ((typeof value !== "string" && typeof value !== "number") || !/^\d+$/.test(String(value))) {
    throw new Error(`${label} must be an unsigned integer string or number`);
  }
  return BigInt(value);
}

function decodeLifecycleEvent(value: unknown): LifecycleEvent {
  const event = value as LifecycleEvent & { market: LifecycleEvent["market"] & { slot: string | number; oraclePoints: Array<LifecycleEvent["market"]["oraclePoints"][number] & { slot: string | number; priceE8: string | number; confidenceE8: string | number }> } };
  if (!event || typeof event !== "object" || !event.market || !Array.isArray(event.market.oraclePoints)) {
    throw new Error("webhook lifecycle event is malformed");
  }
  return {
    ...event,
    market: {
      ...event.market,
      slot: exactInteger(event.market.slot, "event.market.slot"),
      oraclePoints: event.market.oraclePoints.map((point, index) => ({
        ...point,
        slot: exactInteger(point.slot, `event.market.oraclePoints[${index}].slot`),
        priceE8: exactInteger(point.priceE8, `event.market.oraclePoints[${index}].priceE8`),
        confidenceE8: exactInteger(point.confidenceE8, `event.market.oraclePoints[${index}].confidenceE8`),
      })),
    },
  };
}
