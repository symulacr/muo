import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { configuredChainId, resolveConfig } from "@/lib/config";

const KEYS = [
  "NEXT_PUBLIC_MEZO_CHAIN_ID",
  "NEXT_PUBLIC_MEZO_RPC_URL",
  "NEXT_PUBLIC_MEZO_EXPLORER_URL",
  "NEXT_PUBLIC_API_BASE_URL",
  "NEXT_PUBLIC_MUO_CORE_CONTRACT",
  "NEXT_PUBLIC_MUSD_ADDRESS",
] as const;

const CORE = "0x61c41cd7299fd668c3a7aae62f12c017fe654cb0";
const MUSD = "0x118917a40faf1cd7a13db0ef56c86de7973ac503";

const setValid = () => {
  process.env.NEXT_PUBLIC_MUO_CORE_CONTRACT = CORE;
  process.env.NEXT_PUBLIC_MUSD_ADDRESS = MUSD;
};

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

describe("portal configuration", () => {
  test("accepts a minimal valid testnet configuration", () => {
    setValid();
    const result = resolveConfig();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.chainId).toBe(31611);
    expect(result.config.coreAddress).toBe(CORE);
    expect(result.config.musdAddress).toBe(MUSD);
    expect(result.config.rpcUrl).toBe("https://rpc.test.mezo.org");
  });

  test("defaults to testnet when the chain id is unset", () => {
    setValid();
    expect(configuredChainId()).toBe(31611);
  });

  test("accepts mainnet with an explicit chain id", () => {
    setValid();
    process.env.NEXT_PUBLIC_MEZO_CHAIN_ID = "31612";
    const result = resolveConfig();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.chainId).toBe(31612);
    expect(result.config.rpcUrl).toBe("https://rpc.mezo.org");
  });

  test("rejects an unknown chain id instead of silently defaulting", () => {
    setValid();
    process.env.NEXT_PUBLIC_MEZO_CHAIN_ID = "1";
    const result = resolveConfig();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.field === "NEXT_PUBLIC_MEZO_CHAIN_ID")).toBe(true);
  });

  test("rejects a missing core address and reports the field", () => {
    process.env.NEXT_PUBLIC_MUSD_ADDRESS = MUSD;
    const result = resolveConfig();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.field === "NEXT_PUBLIC_MUO_CORE_CONTRACT")).toBe(true);
  });

  test("accepts a checksummed core address and stores it lowercase", () => {
    process.env.NEXT_PUBLIC_MUO_CORE_CONTRACT = "0x61C41cD7299fD668c3a7aAE62F12c017fE654Cb0";
    process.env.NEXT_PUBLIC_MUSD_ADDRESS = "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503";
    const result = resolveConfig();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.coreAddress).toBe(CORE);
    expect(result.config.musdAddress).toBe(MUSD);
  });

  test("rejects a short or non-hex core address", () => {
    process.env.NEXT_PUBLIC_MUSD_ADDRESS = MUSD;
    for (const bad of ["0x1234", `0x${"z".repeat(40)}`, CORE.slice(2)]) {
      process.env.NEXT_PUBLIC_MUO_CORE_CONTRACT = bad;
      expect(resolveConfig().ok).toBe(false);
    }
  });

  test("rejects a non-http explorer or rpc URL", () => {
    setValid();
    process.env.NEXT_PUBLIC_MEZO_RPC_URL = "javascript:alert(1)";
    expect(resolveConfig().ok).toBe(false);
    delete process.env.NEXT_PUBLIC_MEZO_RPC_URL;
    process.env.NEXT_PUBLIC_MEZO_EXPLORER_URL = "file:///etc/passwd";
    expect(resolveConfig().ok).toBe(false);
  });

  test("rejects a malformed URL rather than throwing", () => {
    setValid();
    process.env.NEXT_PUBLIC_MEZO_RPC_URL = "not a url";
    expect(() => resolveConfig()).not.toThrow();
    expect(resolveConfig().ok).toBe(false);
  });

  test("never throws at module scope when everything is unset", () => {
    expect(() => resolveConfig()).not.toThrow();
    expect(resolveConfig().ok).toBe(false);
    expect(configuredChainId()).toBe(31611);
  });
});
