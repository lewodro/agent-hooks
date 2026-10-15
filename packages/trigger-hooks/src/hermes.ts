import { createHmac } from "node:crypto";
import type { WakeDispatcher, WakeRequest } from "./index.js";

export interface HermesDispatcherOptions {
  gatewayUrl: string;
  route: string;
  secret: string;
  profile?: string;
  fetch?: typeof globalThis.fetch;
  nowSeconds?: () => number;
}

/** Send a Generic V2 signed webhook to a user-owned Hermes Agent route. */
export function createHermesDispatcher(options: HermesDispatcherOptions): WakeDispatcher {
  const endpoint = hermesRouteUrl(options);
  if (!options.secret.trim()) throw new Error("Hermes webhook secret is required");
  const send = options.fetch ?? globalThis.fetch;
  return {
    async wake(request: WakeRequest): Promise<void> {
      const timestamp = String(options.nowSeconds?.() ?? Math.floor(Date.now() / 1000));
      const body = JSON.stringify(toHermesPayload(request));
      const signature = createHmac("sha256", options.secret).update(`${timestamp}.${body}`).digest("hex");
      const response = await send(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": request.dedupeKey,
          "x-webhook-timestamp": timestamp,
          "x-webhook-signature-v2": signature,
        },
        body,
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        throw new Error(`Hermes webhook failed (${response.status})${detail ? `: ${detail}` : ""}`);
      }
    },
  };
}

export function toHermesPayload(request: WakeRequest): Record<string, unknown> {
  const event = request.observation.event;
  return {
    event_type: "agent_hooks_trigger",
    trigger_id: request.trigger.id,
    dedupe_key: request.dedupeKey,
    chain: "solana",
    signature: request.observation.signature,
    slot: request.observation.slot.toString(),
    program_id: request.observation.programId,
    ...(event ? { lifecycle_kind: event.kind, adapter: event.adapter, ltv_bps: event.position.ltvBps } : {}),
    instruction: "Inspect this verified observation and prepare a proposal. Do not sign or broadcast automatically.",
  };
}

function hermesRouteUrl(options: HermesDispatcherOptions): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.route)) throw new Error("Hermes route name is invalid");
  if (options.profile && !/^[A-Za-z0-9_-]{1,128}$/.test(options.profile)) throw new Error("Hermes profile name is invalid");
  const url = new URL(options.gatewayUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))) {
    throw new Error("agent webhook URL must use HTTPS unless it targets loopback");
  }
  const prefix = options.profile ? `/p/${options.profile}` : "";
  url.pathname = `${url.pathname.replace(/\/$/, "")}${prefix}/webhooks/${options.route}`;
  return url.toString();
}
