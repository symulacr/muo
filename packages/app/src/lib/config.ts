import type { Address, MezoChainId } from "@muo/core/native";
import { isChainId, MEZO_CHAIN_IDS, MEZO_NETWORKS, normalizeAddress } from "@muo/core/native";

export type AppConfig = {
  chainId: MezoChainId;
  chainName: string;
  rpcUrl: string;
  explorerUrl: string;
  coreAddress: Address;
  musdAddress: Address;
  apiBaseUrl: string;
};

export type ConfigIssue = { field: string; message: string };
export type ConfigResult = { ok: true; config: AppConfig } | { ok: false; issues: ConfigIssue[] };

const DEFAULT_CHAIN_ID = MEZO_CHAIN_IDS.testnet;
/** Plaintext is only acceptable against a loopback host; anything public must be https. */
const isAllowedProtocol = (url: URL) => url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));

/**
 * The public environment, read through LITERAL `process.env.NEXT_PUBLIC_*`
 * member expressions.
 *
 * This is load-bearing: Next inlines `NEXT_PUBLIC_*` at build time by matching
 * the literal `process.env.NAME` text. A dynamic `process.env[name]` lookup is
 * NOT replaced, so it reads `undefined` in the browser and the portal reports
 * itself unconfigured even though the build had the values. Do not refactor this
 * into a loop or a computed key.
 *
 * It is a function (not a frozen object) so tests can mutate `process.env`
 * between cases; in a real build the values are baked and never change.
 */
const readPublicEnv = () =>
  ({
    chainId: process.env.NEXT_PUBLIC_MEZO_CHAIN_ID,
    rpcUrl: process.env.NEXT_PUBLIC_MEZO_RPC_URL,
    explorerUrl: process.env.NEXT_PUBLIC_MEZO_EXPLORER_URL,
    apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL,
    coreAddress: process.env.NEXT_PUBLIC_MUO_CORE_CONTRACT,
    musdAddress: process.env.NEXT_PUBLIC_MUSD_ADDRESS,
  }) as const;

const readEnv = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
};

const parseHttpUrl = (field: string, raw: string | undefined, fallback: string, issues: ConfigIssue[]): string => {
  const value = raw ?? fallback;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    issues.push({ field, message: `${field} must be an absolute URL` });
    return fallback;
  }
  if (!isAllowedProtocol(url)) {
    issues.push({ field, message: `${field} must use https (plaintext http is only allowed for localhost), received ${url.protocol}` });
    return fallback;
  }
  return value;
};

const parseChainId = (raw: string | undefined, issues: ConfigIssue[]): MezoChainId => {
  if (raw === undefined) return DEFAULT_CHAIN_ID;
  const parsed = Number(raw);
  if (!isChainId(parsed)) {
    issues.push({ field: "NEXT_PUBLIC_MEZO_CHAIN_ID", message: `Unsupported Mezo chain id ${raw}; expected 31611 or 31612` });
    return DEFAULT_CHAIN_ID;
  }
  return parsed;
};

const parseAddress = (field: string, raw: string | undefined, issues: ConfigIssue[]): Address | null => {
  if (raw === undefined) {
    issues.push({ field, message: `${field} is not configured` });
    return null;
  }
  // Env values arrive checksummed (as pasted from the explorer) or lowercase; store canonical lowercase.
  try {
    return normalizeAddress(raw);
  } catch {
    issues.push({ field, message: `${field} must be a 20-byte 0x address` });
    return null;
  }
};

/**
 * Resolves the portal configuration from public environment variables.
 *
 * Deliberately lazy: nothing here runs at module scope, so a missing or malformed
 * variable cannot crash `next build`. Callers that need to *write* to the chain must
 * treat `ok: false` as a hard block and surface the issues to the user.
 */
export const resolveConfig = (): ConfigResult => {
  const env = readPublicEnv();
  const issues: ConfigIssue[] = [];
  const chainId = parseChainId(readEnv(env.chainId), issues);
  const network = MEZO_NETWORKS[chainId];

  const rpcUrl = parseHttpUrl("NEXT_PUBLIC_MEZO_RPC_URL", readEnv(env.rpcUrl), network.rpcUrl, issues);
  const explorerUrl = parseHttpUrl("NEXT_PUBLIC_MEZO_EXPLORER_URL", readEnv(env.explorerUrl), network.explorerUrl, issues);
  const apiBaseUrl = parseHttpUrl("NEXT_PUBLIC_API_BASE_URL", readEnv(env.apiBaseUrl), "http://localhost:8787", issues);

  const coreAddress = parseAddress("NEXT_PUBLIC_MUO_CORE_CONTRACT", readEnv(env.coreAddress), issues);
  const musdAddress = parseAddress("NEXT_PUBLIC_MUSD_ADDRESS", readEnv(env.musdAddress), issues);

  if (!coreAddress || !musdAddress || issues.length > 0) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    config: { chainId, chainName: network.name, rpcUrl, explorerUrl, coreAddress, musdAddress, apiBaseUrl },
  };
};

/** Non-throwing read of the chain id, for read-only UI that must still render on misconfiguration. */
export const configuredChainId = (): MezoChainId => {
  const resolved = resolveConfig();
  return resolved.ok ? resolved.config.chainId : parseChainId(readEnv(readPublicEnv().chainId), []);
};

/** Non-throwing read of the RPC URL, defaulting to the allowlisted Mezo endpoint. */
export const configuredRpcUrl = (): string => {
  const env = readPublicEnv();
  const issues: ConfigIssue[] = [];
  const chainId = parseChainId(readEnv(env.chainId), issues);
  return parseHttpUrl("NEXT_PUBLIC_MEZO_RPC_URL", readEnv(env.rpcUrl), MEZO_NETWORKS[chainId].rpcUrl, issues);
};

/** Non-throwing read of the explorer URL, defaulting to the allowlisted Mezo endpoint. */
export const configuredExplorerUrl = (): string => {
  const env = readPublicEnv();
  const issues: ConfigIssue[] = [];
  const chainId = parseChainId(readEnv(env.chainId), issues);
  return parseHttpUrl("NEXT_PUBLIC_MEZO_EXPLORER_URL", readEnv(env.explorerUrl), MEZO_NETWORKS[chainId].explorerUrl, issues);
};

/** Non-throwing read of the API base URL. */
export const configuredApiBaseUrl = (): string => {
  const issues: ConfigIssue[] = [];
  return parseHttpUrl("NEXT_PUBLIC_API_BASE_URL", readEnv(readPublicEnv().apiBaseUrl), "http://localhost:8787", issues);
};

export const describeIssues = (issues: readonly ConfigIssue[]): string =>
  issues.length === 0 ? "Configuration is incomplete." : issues.map((i) => i.message).join(" ");
