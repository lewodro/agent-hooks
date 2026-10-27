export interface MoltbookPostInput {
  submolt: string;
  title: string;
  content?: string;
  url?: string;
}

export interface MoltbookPublisherOptions {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}

export interface MoltbookPostResult {
  postId: string;
  postUrl: string;
}

/** Raised after an ambiguous transport/response failure; inspect the agent feed before retrying. */
export class MoltbookPublicationUncertainError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MoltbookPublicationUncertainError";
  }
}

/** Narrow publisher for a claimed Moltbook agent; credentials go only to the canonical www API host. */
export function createMoltbookPublisher(options: MoltbookPublisherOptions) {
  if (!options.apiKey.trim()) throw new Error("Moltbook API key is required");
  const send = options.fetch ?? globalThis.fetch;

  return {
    async publish(input: MoltbookPostInput): Promise<MoltbookPostResult> {
      validatePost(input);
      let response: Response;
      try {
        response = await send("https://www.moltbook.com/api/v1/posts", {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
          headers: { accept: "application/json", authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ submolt: input.submolt, title: input.title, ...(input.content ? { content: input.content } : {}), ...(input.url ? { url: input.url } : {}) }),
        });
      } catch (error) {
        throw new MoltbookPublicationUncertainError("Moltbook request did not return a response; check the agent feed before retrying", { cause: error });
      }
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        if (response.status >= 500) {
          throw new MoltbookPublicationUncertainError(`Moltbook returned ${response.status}; inspect the agent feed before retrying${detail ? `: ${detail}` : ""}`);
        }
        throw new Error(`Moltbook post request failed (${response.status})${detail ? `: ${detail}` : ""}`);
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        throw new MoltbookPublicationUncertainError("Moltbook may have accepted the post but returned invalid JSON; inspect the feed before retrying", { cause: error });
      }
      const root = asRecord(payload);
      if (root.success !== true) throw new Error("Moltbook did not confirm post creation");
      const data = asRecord(root.data);
      const post = data.post && typeof data.post === "object" ? asRecord(data.post) : data;
      if (typeof post.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(post.id)) {
        throw new MoltbookPublicationUncertainError("Moltbook may have accepted the post but returned no usable post ID; inspect the feed before retrying");
      }
      return { postId: post.id, postUrl: `https://www.moltbook.com/post/${encodeURIComponent(post.id)}` };
    },
  };
}

function validatePost(input: MoltbookPostInput): void {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.submolt)) throw new Error("submolt must be a lowercase slug");
  if (!input.title.trim() || input.title.length > 300) throw new Error("Moltbook title must contain 1-300 characters");
  if (input.content !== undefined && (!input.content.trim() || input.content.length > 20_000)) throw new Error("Moltbook content must contain 1-20000 characters");
  if (input.url !== undefined) {
    let url: URL;
    try { url = new URL(input.url); } catch { throw new Error("Moltbook link must be a valid HTTPS URL"); }
    if (url.protocol !== "https:" || url.username || url.password || input.url.length > 2_048) throw new Error("Moltbook link must be a bounded HTTPS URL without credentials");
  }
  if (input.content === undefined && input.url === undefined) throw new Error("Moltbook post requires content or a URL");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Moltbook returned an invalid post response");
  return value as Record<string, unknown>;
}
