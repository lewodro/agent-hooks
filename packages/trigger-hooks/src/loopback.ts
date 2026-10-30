const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * True when `URL.hostname` names a loopback interface.
 *
 * `URL` keeps the brackets on IPv6 literals, so a bare `::1` comparison misses
 * `http://[::1]:3000` and rejects a valid development endpoint.
 */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}
