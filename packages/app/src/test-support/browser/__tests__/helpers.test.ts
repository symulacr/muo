// Unit tests for the browser-harness PURE helpers.
//
// These need no anvil, no Next server, and no browser: they cover the HTML
// injection, header sanitisation, env baking, and cleanup bookkeeping that the
// real harness depends on. The end-to-end browser flow is NOT covered here.

import { describe, expect, test } from "bun:test";

import { buildPublicEnv } from "@/test-support/browser/harness";
import { API_PREFIX, injectWalletScript, RPC_PREFIX, renderWalletScript, sanitizeHeaders } from "@/test-support/browser/inject-proxy";
import { TEST_ADMIN_SECRET } from "@/test-support/browser/real-api";

describe("wallet script rendering", () => {
  const rendered = renderWalletScript({ accounts: ["0xabc", "0xdef"], chainId: 31611 });

  test("substitutes every placeholder", () => {
    expect(rendered).not.toContain("__RPC_PATH__");
    expect(rendered).not.toContain("__ACCOUNTS__");
    expect(rendered).not.toContain("__CHAIN_ID__");
  });

  test("embeds the RPC path, accounts, and chain id", () => {
    expect(rendered).toContain(RPC_PREFIX);
    expect(rendered).toContain('["0xabc","0xdef"]');
    expect(rendered).toContain("31611");
  });

  test("is explicitly labelled a fake test wallet", () => {
    expect(rendered).toContain("Fake Local Wallet (test)");
    expect(rendered).toContain("isFakeLocalWallet");
  });

  test("contains no private key material", () => {
    // Anvil's well-known dev keys must never appear in the injected script.
    expect(rendered.toLowerCase()).not.toContain("privatekey");
    expect(rendered).not.toContain("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
  });
});

describe("HTML injection", () => {
  const script = "window.__x=1;";

  test("inserts immediately after <head> so it precedes app scripts", () => {
    const html = '<html><head><script src="/_next/a.js"></script></head><body></body></html>';
    const out = injectWalletScript(html, script);
    expect(out.indexOf("window.__x=1")).toBeLessThan(out.indexOf("/_next/a.js"));
  });

  test("tags the script so it is identifiable as test-only", () => {
    expect(injectWalletScript("<head></head>", script)).toContain('data-test-wallet="fake-local"');
  });

  test("handles a <head> with attributes", () => {
    const out = injectWalletScript('<html><head data-x="1"></head></html>', script);
    expect(out).toContain("window.__x=1");
    expect(out.indexOf("window.__x=1")).toBeLessThan(out.indexOf("</head>"));
  });

  test("falls back to prepending when there is no <head>", () => {
    const out = injectWalletScript("<body>hi</body>", script);
    expect(out.startsWith("<script")).toBe(true);
  });

  test("is case-insensitive about the head tag", () => {
    expect(injectWalletScript("<HEAD></HEAD>", script)).toContain("window.__x=1");
  });
});

describe("header sanitisation", () => {
  test("drops hop-by-hop and stale framing headers", () => {
    const src = new Headers({
      connection: "keep-alive",
      "transfer-encoding": "chunked",
      "content-encoding": "gzip",
      "content-length": "1234",
      "content-type": "text/html",
    });
    const out = sanitizeHeaders(src);
    expect(out.get("connection")).toBeNull();
    expect(out.get("transfer-encoding")).toBeNull();
    expect(out.get("content-encoding")).toBeNull();
    expect(out.get("content-length")).toBeNull();
    expect(out.get("content-type")).toBe("text/html");
  });

  test("preserves ordinary headers", () => {
    const out = sanitizeHeaders(new Headers({ "cache-control": "no-store", "x-custom": "v" }));
    expect(out.get("cache-control")).toBe("no-store");
    expect(out.get("x-custom")).toBe("v");
  });

  test("does not mutate the source headers", () => {
    const src = new Headers({ "content-length": "5" });
    sanitizeHeaders(src);
    expect(src.get("content-length")).toBe("5");
  });
});

describe("build-time public env", () => {
  const env = buildPublicEnv({
    proxyPort: 41234,
    coreAddress: "0xAAAABBBBCCCCDDDDEEEEFFFF0000111122223333",
    musdAddress: "0x1111222233334444555566667777888899990000",
    apiUrl: "http://127.0.0.1:5555",
  });

  test("points the RPC and API at the same proxy origin", () => {
    expect(env.NEXT_PUBLIC_MEZO_RPC_URL).toBe(`http://localhost:41234${RPC_PREFIX}`);
    expect(env.NEXT_PUBLIC_API_BASE_URL).toBe(`http://localhost:41234${API_PREFIX}`);
  });

  test("lowercases contract addresses so the strict schema accepts them", () => {
    expect(env.NEXT_PUBLIC_MUO_CORE_CONTRACT).toBe("0xaaaabbbbccccddddeeeeffff0000111122223333");
    expect(env.NEXT_PUBLIC_MUSD_ADDRESS).toBe("0x1111222233334444555566667777888899990000");
  });

  test("pins the Mezo chain id", () => {
    expect(env.NEXT_PUBLIC_MEZO_CHAIN_ID).toBe("31611");
  });

  test("never points at a public or remote RPC", () => {
    for (const value of Object.values(env)) {
      expect(value).not.toContain("rpc.test.mezo.org");
      expect(value).not.toContain("rpc.mezo.org");
      expect(value).not.toContain("explorer.test.mezo.org");
    }
  });
});

describe("real API admin secret", () => {
  test("the test admin secret is a clearly-labelled local placeholder", () => {
    // Guards against someone pasting a real credential into the harness.
    expect(TEST_ADMIN_SECRET).toContain("local-test");
    expect(TEST_ADMIN_SECRET).toContain("not-a-credential");
  });

  test("the secret is non-empty so the /v2/indexer/run route is not 503", () => {
    expect(TEST_ADMIN_SECRET.length).toBeGreaterThan(0);
  });
});
