/** Read-only X API v2 research for public profiles and their recent posts. */
export interface XPublicProfile {
  id: string;
  username: string;
  name: string;
  description: string;
  followers: number | null;
  following: number | null;
  postCount: number | null;
  profileUrl: string;
}

export interface XPublicPost {
  id: string;
  text: string;
  createdAt: string | null;
  likeCount: number | null;
  repostCount: number | null;
  replyCount: number | null;
  url: string;
}

export interface XProfileResearch {
  profile: XPublicProfile;
  posts: readonly XPublicPost[];
  observedAt: string;
  source: "x-api-v2";
}

export interface XResearchOptions {
  bearerToken: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  timeoutMs?: number;
}

const X_API = "https://api.x.com/2";
const MAX_TIMEOUT_MS = 30_000;

/** X API v2 client. It only reads public user/profile/timeline data. */
export function createXResearchClient(options: XResearchOptions) {
  if (!options.bearerToken.trim()) throw new Error("X API bearer token is required");
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be an integer from 100 to ${MAX_TIMEOUT_MS}`);
  }
  const send = options.fetch ?? globalThis.fetch;

  return {
    async researchProfile(handle: string, limit = 10): Promise<XProfileResearch> {
      const username = normalizeHandle(handle);
      if (!Number.isInteger(limit) || limit < 5 || limit > 100) throw new Error("limit must be an integer from 5 to 100");

      const userUrl = new URL(`${X_API}/users/by/username/${encodeURIComponent(username)}`);
      userUrl.searchParams.set("user.fields", "description,public_metrics");
      const userPayload = await getJson(send, userUrl, options.bearerToken, timeoutMs);
      const user = record(record(userPayload, "X user response").data, "X user data");
      const userId = stringField(user, "id");
      if (!/^\d{1,19}$/.test(userId)) throw new Error("X returned an invalid user ID");
      const actualUsername = stringField(user, "username");
      if (!/^[A-Za-z0-9_]{1,15}$/.test(actualUsername)) throw new Error("X returned an invalid username");
      const metrics = optionalRecord(user.public_metrics, "X public metrics");

      const timelineUrl = new URL(`${X_API}/users/${encodeURIComponent(userId)}/tweets`);
      timelineUrl.searchParams.set("max_results", String(limit));
      timelineUrl.searchParams.set("tweet.fields", "created_at,public_metrics");
      timelineUrl.searchParams.set("exclude", "replies,retweets");
      const timelinePayload = record(await getJson(send, timelineUrl, options.bearerToken, timeoutMs), "X timeline response");
      const rawPosts = timelinePayload.data;
      if (rawPosts !== undefined && !Array.isArray(rawPosts)) throw new Error("X returned an invalid timeline");
      const posts = (rawPosts ?? []).map((value: unknown) => {
        const post = record(value, "X post");
        const id = stringField(post, "id");
        if (!/^\d{1,19}$/.test(id)) throw new Error("X returned an invalid post ID");
        const postMetrics = optionalRecord(post.public_metrics, "X post metrics");
        const createdAt = optionalString(post.created_at, "X post created_at");
        if (createdAt !== null && !Number.isFinite(Date.parse(createdAt))) throw new Error("X returned an invalid post timestamp");
        return {
          id, text: stringField(post, "text"), createdAt,
          likeCount: metric(postMetrics, "like_count"), repostCount: metric(postMetrics, "retweet_count"),
          replyCount: metric(postMetrics, "reply_count"), url: `https://x.com/${actualUsername}/status/${id}`,
        } satisfies XPublicPost;
      });

      return {
        profile: {
          id: userId, username: actualUsername, name: stringField(user, "name"),
          description: optionalString(user.description, "X profile description") ?? "",
          followers: metric(metrics, "followers_count"), following: metric(metrics, "following_count"),
          postCount: metric(metrics, "tweet_count"), profileUrl: `https://x.com/${actualUsername}`,
        },
        posts,
        observedAt: (options.now ?? (() => new Date()))().toISOString(),
        source: "x-api-v2",
      };
    },
  };
}

async function getJson(fetcher: typeof globalThis.fetch, url: URL, token: string, timeoutMs: number): Promise<unknown> {
  const response = await fetcher(url, {
    method: "GET", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json", authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`X API request failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  return response.json();
}

function normalizeHandle(value: string): string {
  const handle = value.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new Error("X handle must be 1-15 letters, digits, or underscores");
  return handle;
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is malformed`);
  return value as Record<string, unknown>;
}
function optionalRecord(value: unknown, label: string): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  return record(value, label);
}
function stringField(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== "string") throw new Error(`X field ${key} is missing or invalid`);
  return value[key] as string;
}
function optionalString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  return value;
}
function metric(value: Record<string, unknown> | null, key: string): number | null {
  if (value === null || value[key] === undefined || value[key] === null) return null;
  const result = value[key];
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0) throw new Error(`X metric ${key} is invalid`);
  return result;
}
