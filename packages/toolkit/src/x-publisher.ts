import type { XPublisher } from "./x.js";

export interface XApiPublisherOptions {
  /** X OAuth user access token with permission to create posts. */
  userAccessToken: string;
  fetch?: typeof globalThis.fetch;
}

/** Posts through X API v2. It never scrapes or automates the X website. */
export function createXApiPublisher(options: XApiPublisherOptions): XPublisher {
  if (!options.userAccessToken.trim()) throw new Error("X user access token is required");
  const send = options.fetch ?? globalThis.fetch;
  return {
    async publish(text: string): Promise<{ postId: string }> {
      if (!text.trim() || text.length > 4_000) throw new Error("X post text must contain 1-4000 characters");
      const response = await send("https://api.x.com/2/tweets", {
        method: "POST", redirect: "error",
        headers: { accept: "application/json", authorization: `Bearer ${options.userAccessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        throw new Error(`X post request failed (${response.status})${detail ? `: ${detail}` : ""}`);
      }
      const payload: unknown = await response.json();
      const data = objectField(payload, "data");
      const id = data.id;
      if (typeof id !== "string" || !/^\d{1,19}$/.test(id)) {
        // X may have accepted the post even if its response was incomplete; callers must reconcile, not retry blindly.
        throw new Error("X returned an invalid post ID after accepting the request; publication outcome is uncertain");
      }
      return { postId: id };
    },
  };
}

function objectField(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("X returned an invalid post response");
  const result = (value as Record<string, unknown>)[key];
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("X returned an invalid post response");
  return result as Record<string, unknown>;
}
