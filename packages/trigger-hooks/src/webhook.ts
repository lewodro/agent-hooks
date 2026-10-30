import { createHmac } from "node:crypto";
import type { WakeDispatcher, WakeRequest } from "./index.js";
import { toHermesPayload } from "./hermes.js";
import { isLoopbackHost } from "./loopback.js";

export interface WebhookDispatcherOptions {
  url: string;
  bearerToken?: string;
  hmacSecret?: string;
  headers?: Readonly<Record<string, string>>;
  fetch?: typeof globalThis.fetch;
  nowSeconds?: () => number;
}

/** Generic adapter for LangGraph, CrewAI, custom bots, and hosted agent workers. */
export function createWebhookDispatcher(options: WebhookDispatcherOptions): WakeDispatcher {
  const url = safeWebhookUrl(options.url);
  const send = options.fetch ?? globalThis.fetch;
  return {
    async wake(request: WakeRequest): Promise<void> {
      const timestamp = String(options.nowSeconds?.() ?? Math.floor(Date.now() / 1000));
      const body = JSON.stringify(toHermesPayload(request));
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-agent-hooks-delivery": request.dedupeKey,
        "x-agent-hooks-timestamp": timestamp,
        ...options.headers,
      };
      if (options.bearerToken) headers.authorization = `Bearer ${options.bearerToken}`;
      if (options.hmacSecret) {
        headers["x-agent-hooks-signature"] = `sha256=${createHmac("sha256", options.hmacSecret).update(`${timestamp}.${body}`).digest("hex")}`;
      }
      const response = await send(url, { method: "POST", headers, body });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        throw new Error(`agent webhook failed (${response.status})${detail ? `: ${detail}` : ""}`);
      }
    },
  };
}

function safeWebhookUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password) throw new Error("agent webhook credentials must use headers, not URL user info");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new Error("agent webhook URL must use HTTPS unless it targets loopback");
  }
  return url.toString();
}
