// TEST-ONLY reverse proxy that injects the fake wallet before any app script.
//
// Why a proxy instead of app code: the portal must NOT contain a test wallet
// override or backdoor. Nothing here is imported by the app, and nothing here is
// part of a production build. The app is served exactly as built; this proxy only
// rewrites the HTML of the document response to prepend one script.
//
// Same-origin design: the proxy also fronts the anvil RPC (`/__rpc`) and the
// assertions API fixture (`/__api`). The browser therefore talks to ONE origin,
// which removes CORS from the picture entirely and means the build-time
// `NEXT_PUBLIC_*` URLs can point back at this same origin.
//
// Scope:
//  - binds 127.0.0.1 only
//  - forwards to a loopback Next server, loopback anvil RPC, loopback API fixture
//  - injects `wallet-inject.js` into `text/html` responses only
//  - no external network, no private keys

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const WALLET_SOURCE = readFileSync(join(here, "wallet-inject.js"), "utf8");

/** Path prefix routed to the local anvil JSON-RPC endpoint. */
export const RPC_PREFIX = "/__rpc";
/** Path prefix routed to the assertions API fixture. */
export const API_PREFIX = "/__api";

export type InjectOptions = {
  /** Port to listen on. Allocate it before building so the URL can be baked in. */
  port: number;
  /** Absolute URL of the upstream Next server, e.g. http://127.0.0.1:3000 */
  upstream: string;
  /** Absolute URL of the local anvil JSON-RPC endpoint. */
  rpcUrl: string;
  /** Absolute URL of the assertions API fixture (no trailing slash). */
  apiUrl: string;
  /** Unlocked anvil accounts the fake wallet exposes. */
  accounts: readonly string[];
  chainId: number;
};

export type InjectProxy = { url: string; port: number; stop: () => Promise<void> };

/** Renders the wallet script with the fixture values substituted. */
export const renderWalletScript = (opts: Pick<InjectOptions, "accounts" | "chainId">): string =>
  WALLET_SOURCE.replace("__RPC_PATH__", RPC_PREFIX).replace("__ACCOUNTS__", JSON.stringify(opts.accounts)).replace("__CHAIN_ID__", String(opts.chainId));

/** Headers that must not be forwarded across a proxy hop. */
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];

/**
 * Copies upstream headers onto a fresh Headers, dropping hop-by-hop and
 * length/encoding headers that no longer describe the rewritten body.
 */
export const sanitizeHeaders = (source: Headers): Headers => {
  const out = new Headers(source);
  for (const h of HOP_BY_HOP) out.delete(h);
  // The body may be rewritten (HTML injection) or re-streamed, so let the
  // runtime recompute framing rather than trusting the upstream values.
  out.delete("content-length");
  out.delete("content-encoding");
  return out;
};

/** Inserts the wallet script immediately after `<head>` so it precedes app scripts. */
export const injectWalletScript = (html: string, script: string): string => {
  const tag = `<script data-test-wallet="fake-local">${script}</script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${tag}`);
  // No <head> (unexpected for a Next document): prepend so it still runs first.
  return `${tag}${html}`;
};

const isHtml = (contentType: string | null): boolean => (contentType ?? "").toLowerCase().includes("text/html");

/**
 * Starts the injecting proxy on a pre-allocated port.
 *
 * The port is supplied by the caller because the build-time `NEXT_PUBLIC_*` URLs
 * must point at this origin, so it has to be known before the app is built.
 */
export const startInjectProxy = (opts: InjectOptions): InjectProxy => {
  const script = renderWalletScript(opts);

  const forward = async (request: Request, target: URL): Promise<Response> => {
    const headers = sanitizeHeaders(request.headers);
    headers.delete("host");
    headers.delete("accept-encoding"); // keep bodies uncompressed so HTML is rewritable

    const method = request.method.toUpperCase();
    const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();

    const res = await fetch(target, { method, headers, body, redirect: "manual" });
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: sanitizeHeaders(res.headers) });
  };

  const server = Bun.serve({
    port: opts.port,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);

      // Same-origin RPC for the injected wallet and for viem's http transport.
      // anvil serves JSON-RPC at its root, so the prefix is dropped.
      if (url.pathname === RPC_PREFIX || url.pathname.startsWith(`${RPC_PREFIX}/`)) {
        return forward(request, new URL(opts.rpcUrl));
      }

      // Same-origin assertions API fixture.
      if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
        const rest = url.pathname.slice(API_PREFIX.length) || "/";
        return forward(request, new URL(rest + url.search, opts.apiUrl));
      }

      // Everything else is the Next app.
      const upstreamRes = await forward(request, new URL(url.pathname + url.search, opts.upstream));

      if (!isHtml(upstreamRes.headers.get("content-type"))) return upstreamRes;

      const html = await upstreamRes.text();
      const injected = injectWalletScript(html, script);
      const headers = new Headers(upstreamRes.headers);
      headers.delete("content-length"); // body length changed
      headers.delete("content-encoding");
      return new Response(injected, { status: upstreamRes.status, statusText: upstreamRes.statusText, headers });
    },
  });

  const port = server.port;
  if (typeof port !== "number") {
    void server.stop(true);
    throw new Error("Browser proxy did not bind a TCP port");
  }
  return {
    url: `http://localhost:${port}`,
    port,
    stop: async () => {
      await server.stop(true);
    },
  };
};
