// Safety tests for the read-only RPC surface.
//
// These prove three properties that cannot be checked by reading the probe
// script alone:
//   1. the method allowlist refuses every state-changing method
//   2. there is no code path that can broadcast (the client has no send method)
//   3. the probe's call budget is enforced at the transport boundary
//
// No network access: every test injects a fake `fetchImpl`.

import { describe, expect, test } from "bun:test";

import { MezoRpc, READ_ONLY_METHODS, RpcError } from "../lib/mezo/rpc";

const ok = (result: unknown) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/**
 * Methods that must NEVER be reachable. Grouped so a failure names the class.
 */
const FORBIDDEN = [
  // transaction broadcast
  "eth_sendTransaction",
  "eth_sendRawTransaction",
  "eth_signTransaction",
  // signing / keys
  "eth_sign",
  "eth_signTypedData",
  "eth_signTypedData_v4",
  "personal_sign",
  "personal_unlockAccount",
  "personal_newAccount",
  // wallet namespaces
  "wallet_sendCalls",
  "wallet_sign",
  "wallet_requestPermissions",
  // EIP-2612 permit is a contract call, not an RPC method, but a faucet/mint
  // helper must not exist either
  "hardhat_setBalance",
  "anvil_setBalance",
  "evm_mine",
  "evm_snapshot",
  "evm_revert",
  "miner_start",
  "admin_addPeer",
  "debug_traceTransaction",
  "txpool_status",
] as const;

describe("method allowlist", () => {
  test("the allowlist contains only read methods", () => {
    expect([...READ_ONLY_METHODS].sort()).toEqual(["eth_blockNumber", "eth_call", "eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getLogs"]);
    for (const m of READ_ONLY_METHODS) {
      expect(m).not.toMatch(/send|sign|permit|wallet|faucet|unlock|mine|snapshot|revert/i);
    }
  });

  test.each(FORBIDDEN)("refuses %s without issuing a request", async (method) => {
    let called = false;
    const rpc = new MezoRpc({
      url: "http://127.0.0.1:1",
      timeoutMs: 100,
      maxRetries: 0,
      backoffMs: 1,
      fetchImpl: (async () => {
        called = true;
        return ok("0x0");
      }) as unknown as typeof fetch,
    });

    // `call` is private; reach it the way a future edit would — through a cast.
    const reach = (rpc as unknown as { call: (m: string, p: unknown[]) => Promise<unknown> }).call.bind(rpc);
    await expect(reach(method, [])).rejects.toThrow(RpcError);
    await expect(reach(method, [])).rejects.toThrow(/refusing non-read-only method/);
    // The guard fires BEFORE the transport, so nothing left the process.
    expect(called).toBe(false);
  });

  test("a read method still reaches the transport", async () => {
    let called = 0;
    const rpc = new MezoRpc({
      url: "http://127.0.0.1:1",
      timeoutMs: 100,
      maxRetries: 0,
      backoffMs: 1,
      fetchImpl: (async () => {
        called++;
        // 31611 = 0x7b7b
        return ok("0x7b7b");
      }) as unknown as typeof fetch,
    });
    expect(await rpc.chainId()).toBe(31611);
    expect(called).toBe(1);
  });
});

describe("no broadcast surface", () => {
  test("the client exposes no send/sign/permit method", () => {
    const proto = MezoRpc.prototype as unknown as Record<string, unknown>;
    const names = Object.getOwnPropertyNames(proto);
    for (const n of names) {
      expect(n).not.toMatch(/send|sign|permit|broadcast|transfer|approve|wallet/i);
    }
    // The read surface that does exist.
    for (const n of ["chainId", "blockNumber", "getBlock", "getLogs", "getCode", "callContract"]) {
      expect(names).toContain(n);
    }
  });

  test("getCode and callContract reject non-canonical hex responses", async () => {
    const rpc = new MezoRpc({
      url: "http://127.0.0.1:1",
      timeoutMs: 100,
      maxRetries: 0,
      backoffMs: 1,
      fetchImpl: (async () => ok("not-hex")) as unknown as typeof fetch,
    });
    await expect(rpc.getCode("0x61c41cd7299fd668c3a7aae62f12c017fe654cb0")).rejects.toThrow(/canonical hex/);
    await expect(rpc.callContract("0x61c41cd7299fd668c3a7aae62f12c017fe654cb0", "0x")).rejects.toThrow(/canonical hex/);
  });

  test("eth_getLogs refuses a range above the block cap", async () => {
    const rpc = new MezoRpc({
      url: "http://127.0.0.1:1",
      timeoutMs: 100,
      maxRetries: 0,
      backoffMs: 1,
      fetchImpl: (async () => ok([])) as unknown as typeof fetch,
    });
    await expect(
      rpc.getLogs({
        address: "0x61c41cd7299fd668c3a7aae62f12c017fe654cb0",
        topics: [`0x${"11".repeat(32)}`],
        fromBlock: 0,
        toBlock: 10_000_000,
      })
    ).rejects.toThrow(/exceeds the .* cap/);
  });

  test("eth_getLogs refuses an inverted range", async () => {
    const rpc = new MezoRpc({
      url: "http://127.0.0.1:1",
      timeoutMs: 100,
      maxRetries: 0,
      backoffMs: 1,
      fetchImpl: (async () => ok([])) as unknown as typeof fetch,
    });
    await expect(
      rpc.getLogs({
        address: "0x61c41cd7299fd668c3a7aae62f12c017fe654cb0",
        topics: [],
        fromBlock: 100,
        toBlock: 99,
      })
    ).rejects.toThrow(/empty or inverted/);
  });
});

describe("call budget", () => {
  test("a budgeted fetch stops at the cap instead of continuing", async () => {
    const MAX = 3;
    let calls = 0;
    const budgeted = (async () => {
      calls++;
      if (calls > MAX) throw new RpcError(`probe budget exhausted at ${MAX} calls`, undefined, false);
      // 31611 = 0x7b7b
      return ok("0x7b7b");
    }) as unknown as typeof fetch;

    const rpc = new MezoRpc({ url: "http://127.0.0.1:1", timeoutMs: 100, maxRetries: 0, backoffMs: 1, fetchImpl: budgeted });

    // Three reads succeed.
    for (let i = 0; i < MAX; i++) expect(await rpc.chainId()).toBe(31611);
    // The fourth is refused by the budget, not by the network.
    await expect(rpc.chainId()).rejects.toThrow(/budget exhausted/);
    expect(calls).toBe(MAX + 1);
  });

  test("a non-retryable JSON-RPC error is not retried", async () => {
    let calls = 0;
    const rpc = new MezoRpc({
      url: "http://127.0.0.1:1",
      timeoutMs: 100,
      maxRetries: 3,
      backoffMs: 1,
      fetchImpl: (async () => {
        calls++;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not found" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
    await expect(rpc.chainId()).rejects.toThrow(/method not found/);
    // A protocol answer is final: exactly one request.
    expect(calls).toBe(1);
  });
});
