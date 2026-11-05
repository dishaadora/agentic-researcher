import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/**
 * Agents and users supply URLs here, so this must never reach internal services. The address is
 * checked inside the socket's own DNS lookup, so a hostname can't pass a check and then rebind to
 * a private address. Redirects are followed by hand, and each hop is checked the same way.
 */
const BLOCKED = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(network, prefix, "ipv4");
}
BLOCKED.addAddress("::", "ipv6");
BLOCKED.addAddress("::1", "ipv6");
BLOCKED.addSubnet("64:ff9b::", 96, "ipv6");
BLOCKED.addSubnet("fc00::", 7, "ipv6");
BLOCKED.addSubnet("fe80::", 10, "ipv6");
BLOCKED.addSubnet("ff00::", 8, "ipv6");

export function isBlockedAddress(address: string) {
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (mapped) return BLOCKED.check(mapped, "ipv4");
  const family = net.isIP(address);
  if (family === 0) return true;
  return BLOCKED.check(address, family === 4 ? "ipv4" : "ipv6");
}

export class BlockedUrlError extends Error {}

export function assertAllowedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError("Not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new BlockedUrlError("Only http and https are allowed");
  if (url.username || url.password) throw new BlockedUrlError("URLs with credentials are not allowed");
  if (url.port && url.port !== "80" && url.port !== "443") throw new BlockedUrlError("Only standard ports are allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isBlockedAddress(host)) throw new BlockedUrlError("Private addresses are not allowed");
  if (!net.isIP(host) && (!host.includes(".") || /\.(local|internal|localhost)$/i.test(host))) {
    throw new BlockedUrlError("Internal hostnames are not allowed");
  }
  return url;
}

const safeLookup: net.LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "", 0);
    const list = addresses as unknown as { address: string; family: number }[];
    if (list.length === 0 || list.some(({ address }) => isBlockedAddress(address))) {
      return callback(new BlockedUrlError(`Refused to connect to ${hostname}`), "", 0);
    }
    if (options.all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
    const first = list[0]!;
    callback(null, first.address, first.family);
  });
};

export type SafeResponse = {
  status: number;
  finalUrl: string;
  contentType: string;
  /** The first redirect target, if any, without following further. */
  redirectedTo: string | null;
  body: string;
  truncated: boolean;
};

type Options = { timeoutMs?: number; maxBytes?: number; maxRedirects?: number; signal?: AbortSignal };

function requestOnce(url: URL, { timeoutMs, maxBytes, signal }: Required<Pick<Options, "timeoutMs" | "maxBytes">> & Pick<Options, "signal">) {
  return new Promise<Omit<SafeResponse, "finalUrl" | "redirectedTo"> & { location: string | null }>((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(
      url,
      {
        method: "GET",
        lookup: safeLookup,
        signal,
        timeout: timeoutMs,
        headers: {
          "user-agent": "oauth-path-finder/0.1 (read-only documentation check)",
          accept: "text/html,application/json,text/plain,*/*;q=0.5",
          // Some docs sites localize by location, which would break matching on English quotes.
          "accept-language": "en-US,en;q=0.9",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            truncated = true;
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        const finish = () =>
          resolve({
            status: response.statusCode ?? 0,
            contentType: String(response.headers["content-type"] ?? ""),
            location: response.headers.location ?? null,
            body: Buffer.concat(chunks).toString("utf8"),
            truncated,
          });
        response.on("end", finish);
        response.on("close", finish);
        response.on("error", (error) => (truncated ? finish() : reject(error)));
      },
    );
    request.on("timeout", () => request.destroy(new Error(`Timed out after ${timeoutMs} ms`)));
    request.on("error", reject);
    request.end();
  });
}

export async function safeFetch(raw: string, options: Options = {}): Promise<SafeResponse> {
  const { timeoutMs = 15_000, maxBytes = 3_000_000, maxRedirects = 4, signal } = options;
  let url = assertAllowedUrl(raw);
  let redirectedTo: string | null = null;
  for (let hop = 0; ; hop++) {
    const { location, ...response } = await requestOnce(url, { timeoutMs, maxBytes, signal });
    const isRedirect = response.status >= 300 && response.status < 400 && location;
    if (!isRedirect) return { ...response, finalUrl: url.href, redirectedTo };
    const next = new URL(location, url).href;
    redirectedTo ??= next;
    if (hop >= maxRedirects) return { ...response, finalUrl: url.href, redirectedTo };
    url = assertAllowedUrl(next);
  }
}
