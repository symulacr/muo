import { describe, expect, test } from "bun:test";

import {
  ACCOUNTS_TIMEOUT_MS,
  addChainToWallet,
  ensureChain,
  isUserRejection,
  readAccounts,
  readChainId,
  requestAccounts,
  watchMusd,
} from "@/lib/wallet-eip1193";
import { FakeProvider, OTHER_ACCOUNT, TEST_ACCOUNT } from "@/test-support/fake-provider";

/** Mezo testnet MUSD, lowercase as `config.ts` normalizes it. */
const MUSD = "0x118917a40faf1cd7a13db0ef56c86de7973ac503" as const;

describe("EIP-1193 wallet primitives", () => {
  test("reads the chain id as a number", async () => {
    expect(await readChainId(new FakeProvider({ chainId: 31611 }))).toBe(31611);
    expect(await readChainId(new FakeProvider({ chainId: 31612 }))).toBe(31612);
  });

  test("rejects a malformed chain id payload", async () => {
    const p = new FakeProvider();
    p.queue("eth_chainId", async () => "not-hex");
    await expect(readChainId(p)).rejects.toThrow();
  });

  test("normalizes accounts to lowercase", async () => {
    const p = new FakeProvider({ accounts: [TEST_ACCOUNT.toUpperCase().replace("0X", "0x") as typeof TEST_ACCOUNT] });
    expect(await readAccounts(p)).toEqual([TEST_ACCOUNT]);
  });

  test("drops malformed account entries instead of failing", async () => {
    const p = new FakeProvider();
    p.queue("eth_accounts", async () => [TEST_ACCOUNT, "0x1234", 42]);
    expect(await readAccounts(p)).toEqual([TEST_ACCOUNT]);
  });

  test("returns an empty list when the wallet approves but shares no account", async () => {
    const p = new FakeProvider({ accounts: [] });
    p.queue("eth_requestAccounts", async () => []);
    expect(await requestAccounts(p)).toEqual([]);
  });

  test("surfaces a 4001 rejection from eth_requestAccounts", async () => {
    const p = new FakeProvider({ accounts: [] });
    try {
      await requestAccounts(p);
      throw new Error("expected rejection");
    } catch (e) {
      expect(isUserRejection(e)).toBe(true);
    }
  });

  test("a wallet that never answers eth_requestAccounts is bounded, not hung", async () => {
    // Regression: an installed-but-not-onboarded wallet never settles this promise, so the
    // Connect button stayed on "Connecting ..." forever with no error and no way out.
    const p = new FakeProvider({ accounts: [] });
    p.queue("eth_requestAccounts", () => new Promise<never>(() => {}));
    const started = Date.now();
    await expect(requestAccounts(p, 120)).rejects.toThrow(/did not respond/i);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  test("the default bound is 30s, long enough for a slow but working approval", () => {
    expect(ACCOUNTS_TIMEOUT_MS).toBe(30_000);
  });

  test("a wallet that answers before the bound is unaffected", async () => {
    const p = new FakeProvider({ accounts: [TEST_ACCOUNT] });
    expect(await requestAccounts(p, 5_000)).toEqual([TEST_ACCOUNT]);
  });

  test("ensureChain is a no-op when already on the target chain", async () => {
    const p = new FakeProvider({ chainId: 31611 });
    expect(await ensureChain(p, 31611)).toBe(true);
    expect(p.requests.some((r) => r.method === "wallet_switchEthereumChain")).toBe(false);
  });

  test("ensureChain switches to the target chain", async () => {
    const p = new FakeProvider({ chainId: 1 });
    expect(await ensureChain(p, 31611)).toBe(true);
    expect(p.chainId).toBe(31611);
  });

  test("ensureChain falls back to add-then-switch when the chain is unknown", async () => {
    const p = new FakeProvider({ chainId: 1 });
    p.queue("wallet_switchEthereumChain", async () => {
      throw Object.assign(new Error("Unrecognized chain"), { code: 4902 });
    });
    expect(await ensureChain(p, 31612)).toBe(true);
    expect(p.requests.some((r) => r.method === "wallet_addEthereumChain")).toBe(true);
  });

  test("ensureChain returns false when the user refuses both prompts", async () => {
    const p = new FakeProvider({ chainId: 1 });
    p.queue("wallet_switchEthereumChain", async () => {
      throw Object.assign(new Error("rejected"), { code: 4001 });
    });
    p.queue("wallet_addEthereumChain", async () => {
      throw Object.assign(new Error("rejected"), { code: 4001 });
    });
    expect(await ensureChain(p, 31611)).toBe(false);
  });

  test("ensureChain does not offer to add the chain after a 4001 rejection", async () => {
    const p = new FakeProvider({ chainId: 1 });
    p.queue("wallet_switchEthereumChain", async () => {
      throw Object.assign(new Error("rejected"), { code: 4001 });
    });
    expect(await ensureChain(p, 31611)).toBe(false);
    expect(p.requests.some((r) => r.method === "wallet_addEthereumChain")).toBe(false);
  });

  test("ensureChain does not offer to add the chain on an unrelated failure", async () => {
    const p = new FakeProvider({ chainId: 1 });
    p.queue("wallet_switchEthereumChain", async () => {
      throw Object.assign(new Error("pending"), { code: -32002 });
    });
    expect(await ensureChain(p, 31611)).toBe(false);
    expect(p.requests.some((r) => r.method === "wallet_addEthereumChain")).toBe(false);
  });

  test("ensureChain falls back to add-then-switch when the code is nested (MetaMask Mobile)", async () => {
    const p = new FakeProvider({ chainId: 1 });
    p.queue("wallet_switchEthereumChain", async () => {
      throw Object.assign(new Error("Unrecognized chain"), { data: { originalError: { code: 4902 } } });
    });
    expect(await ensureChain(p, 31612)).toBe(true);
    expect(p.requests.some((r) => r.method === "wallet_addEthereumChain")).toBe(true);
  });

  test("addChainToWallet sends hex chainId and the canonical nativeCurrency", async () => {
    const p = new FakeProvider({ chainId: 31611 });
    expect(await addChainToWallet(p, 31611)).toBe(true);
    const sent = p.requests.find((r) => r.method === "wallet_addEthereumChain");
    if (!sent) throw new Error("wallet_addEthereumChain was not requested");
    const [chain] = sent.params as [{ chainId: string; nativeCurrency: { name: string; symbol: string; decimals: number }; rpcUrls: string[] }];
    // 31611 === 0x7b7b. Mezo's own docs cite 0x7A5B (= 31323), which is wrong.
    expect(chain.chainId).toBe("0x7b7b");
    expect(chain.nativeCurrency).toEqual({ name: "Bitcoin", symbol: "BTC", decimals: 18 });
    expect(chain.rpcUrls).toEqual(["https://rpc.test.mezo.org"]);
  });

  test("addChainToWallet reports false instead of throwing when the user refuses", async () => {
    const p = new FakeProvider();
    p.queue("wallet_addEthereumChain", async () => {
      throw Object.assign(new Error("rejected"), { code: 4001 });
    });
    expect(await addChainToWallet(p, 31611)).toBe(false);
  });

  test("watchMusd requests an ERC20 display with the configured decimals", async () => {
    const p = new FakeProvider();
    p.queue("wallet_watchAsset", async () => true);
    expect(await watchMusd(p, MUSD)).toBe(true);
    const sent = p.requests.find((r) => r.method === "wallet_watchAsset");
    expect(sent?.params).toMatchObject({
      type: "ERC20",
      // EIP-747 requires EIP-55 checksum casing, not the lowercase config form.
      options: { address: "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503", symbol: "MUSD", decimals: 18 },
    });
  });

  test("watchMusd is false when the user declines or the wallet rejects", async () => {
    const declined = new FakeProvider();
    declined.queue("wallet_watchAsset", async () => false);
    expect(await watchMusd(declined, MUSD)).toBe(false);

    const thrown = new FakeProvider();
    thrown.queue("wallet_watchAsset", async () => {
      throw Object.assign(new Error("rejected"), { code: 4001 });
    });
    expect(await watchMusd(thrown, MUSD)).toBe(false);
  });

  test("isUserRejection accepts 4001 and the viem error name only", () => {
    expect(isUserRejection({ code: 4001 })).toBe(true);
    expect(isUserRejection({ name: "UserRejectedRequestError" })).toBe(true);
    expect(isUserRejection({ code: -32000 })).toBe(false);
    expect(isUserRejection(new Error("insufficient funds"))).toBe(false);
    expect(isUserRejection(null)).toBe(false);
  });

  test("account and chain listeners can be registered and removed", () => {
    const p = new FakeProvider({ accounts: [TEST_ACCOUNT] });
    const seen: unknown[] = [];
    const handler = (...args: unknown[]) => seen.push(args[0]);
    p.on("accountsChanged", handler);
    p.emit("accountsChanged", OTHER_ACCOUNT);
    expect(seen).toEqual([OTHER_ACCOUNT]);
    p.removeListener("accountsChanged", handler);
    p.emit("accountsChanged", TEST_ACCOUNT);
    expect(seen).toEqual([OTHER_ACCOUNT]);
    expect(p.listenerCount("accountsChanged")).toBe(0);
  });
});
