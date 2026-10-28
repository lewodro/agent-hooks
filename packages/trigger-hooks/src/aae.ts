import { createHmac } from "node:crypto";

/** Minimal public fields from AAE's Rust EconomyEvent wire format. Amounts stay decimal strings. */
export interface AaeEconomyEvent {
  schema_version: number;
  seq: number;
  match_id: string;
  type: string;
  projection?: {
    payment_mode?: string;
    state?: string;
    settlement_status?: string;
    pot_amount?: string;
  };
  [field: string]: unknown;
}

export interface AaeWakeEnvelope {
  schema: "agent-hooks/aae-economy-event@1";
  delivery_id: string;
  source: "autonomous-agent-economy";
  trust: "notification_only";
  event: AaeEconomyEvent;
}

export interface AaeWebhookOptions {
  url: string;
  bearerToken?: string;
  hmacSecret?: string;
  fetch?: typeof globalThis.fetch;
  nowSeconds?: () => number;
}

/** Validate and clone one event emitted by AAE's versioned Rust economy event contract. */
export function parseAaeEconomyEvent(value: unknown): AaeEconomyEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("AAE economy event must be an object");
  const event = value as Record<string, unknown>;
  if (event.schema_version !== 1) throw new Error("unsupported AAE economy event schema_version");
  if (!Number.isSafeInteger(event.seq) || (event.seq as number) < 0) throw new Error("AAE economy event seq must be a non-negative safe integer");
  if (typeof event.match_id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(event.match_id)) throw new Error("AAE economy event match_id is invalid");
  if (typeof event.type !== "string" || !/^[A-Z][A-Za-z]{0,63}$/.test(event.type)) throw new Error("AAE economy event type is invalid");
  const projection = event.projection;
  if (projection !== undefined && (!projection || typeof projection !== "object" || Array.isArray(projection))) {
    throw new Error("AAE economy event projection must be an object");
  }
  const amount = (projection as Record<string, unknown> | undefined)?.pot_amount;
  if (amount !== undefined && (typeof amount !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(amount))) {
    throw new Error("AAE pot_amount must be a canonical base-unit string");
  }
  return structuredClone(event) as AaeEconomyEvent;
}

/** Build a signed, idempotent webhook delivery for an AAE event. This only wakes an agent. */
export function createAaeWebhookDispatcher(options: AaeWebhookOptions) {
  const url = new URL(options.url);
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)))) {
    throw new Error("AAE webhook URL must use HTTPS except for loopback and cannot embed credentials");
  }
  if (options.bearerToken !== undefined && !options.bearerToken.trim()) throw new Error("AAE webhook bearer token cannot be empty");
  if (options.hmacSecret !== undefined && !options.hmacSecret) throw new Error("AAE webhook HMAC secret cannot be empty");
  const send = options.fetch ?? globalThis.fetch;
  return {
    async wake(value: unknown): Promise<AaeWakeEnvelope> {
      const event = parseAaeEconomyEvent(value);
      const deliveryId = `aae:${event.match_id}:${event.seq}`;
      const envelope: AaeWakeEnvelope = { schema: "agent-hooks/aae-economy-event@1", delivery_id: deliveryId, source: "autonomous-agent-economy", trust: "notification_only", event };
      const body = JSON.stringify(envelope);
      const timestamp = String(options.nowSeconds?.() ?? Math.floor(Date.now() / 1000));
      const headers: Record<string, string> = { "content-type": "application/json", "x-agent-hooks-delivery": deliveryId, "x-agent-hooks-timestamp": timestamp };
      if (options.bearerToken) headers.authorization = `Bearer ${options.bearerToken}`;
      if (options.hmacSecret) headers["x-agent-hooks-signature"] = `sha256=${createHmac("sha256", options.hmacSecret).update(`${timestamp}.${body}`).digest("hex")}`;
      const response = await send(url, { method: "POST", headers, body, redirect: "error" });
      if (!response.ok) throw new Error(`AAE agent webhook failed (${response.status})`);
      return envelope;
    },
  };
}
