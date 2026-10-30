// Bounded JSON-RPC client for the Mezo indexer.
//
// Design constraints:
//   - No `finalized` / `safe` block-tag assumptions. Mezo is not Ethereum and
//     the tags may be unsupported or mean something different. Canonicality is
//     verified by re-reading block hashes, not by trusting a tag.
//   - Every call is bounded: range size, log count, timeout, retries.
//   - `eth_chainId` is validated before any log is trusted.
//
// This module is transport-only. It performs no projection and writes nothing.

import type { Address, Hex, MezoChainId } from "@muo/core/native";
import { normalizeAddress, normalizeHex } from "@muo/core/native";

export type RpcLog = {
  address: string;
  topics: readonly string[];
  data: string;
  blockNumber: string;
  blockHash: string | null;
  transactionHash: string | null;
  transactionIndex: string | null;
  logIndex: string;
  removed?: boolean;
};

export type RpcBlock = {
  number: string;
  hash: Hex;
  parentHash: Hex;
};

export type RpcOptions = {
  url: string;
  /** Per-call timeout. */
  timeoutMs: number;
  /** Retries for transient failures only (network, 429, 5xx). */
  maxRetries: number;
  /** Base backoff; doubles per attempt. */
  backoffMs: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  /** Injected for tests. */
  sleepImpl?: (ms: number) => Promise<void>;
};

export const RPC_LIMITS = {
  /** Hard cap on blocks per `eth_getLogs` call. */
  MAX_BLOCK_RANGE: 2_000,
  /** Hard cap on logs accepted from one call. */
  MAX_LOGS_PER_CALL: 1_000,
  /** Hard cap on blocks per invocation. */
  MAX_BLOCKS_PER_RUN: 5_000,
  /** Default confirmations to wait before treating a block as settled. */
  DEFAULT_CONFIRMATIONS: 12,
  DEFAULT_TIMEOUT_MS: 10_000,
  DEFAULT_MAX_RETRIES: 3,
  DEFAULT_BACKOFF_MS: 250,
} as const;

/** A JSON-RPC or transport failure that the caller must not treat as "no logs". */
export class RpcError extends Error {
  readonly code: number | undefined;
  readonly retryable: boolean;
  constructor(message: string, code?: number, retryable = false) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.retryable = retryable;
  }
}

const isRetryableStatus = (status: number): boolean => status === 408 || status === 429 || status >= 500;

const parseQuantity = (v: unknown, field: string): bigint => {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]+$/.test(v)) throw new RpcError(`${field} is not a hex quantity`);
  return BigInt(v);
};

export const toQuantity = (n: number | bigint): Hex => `0x${(typeof n === "bigint" ? n : BigInt(n)).toString(16)}` as Hex;

/**
 * The ONLY JSON-RPC methods this client will ever send.
 *
 * Every entry is a read. The allowlist is enforced in `call()` rather than
 * documented, so a future edit that reaches for `eth_sendRawTransaction`,
 * `eth_sign`, `personal_*`, `wallet_*` or a faucet method fails at the boundary
 * instead of silently broadcasting.
 */
export const READ_ONLY_METHODS = ["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getLogs", "eth_getCode", "eth_call"] as const;

export type ReadOnlyMethod = (typeof READ_ONLY_METHODS)[number];

const READ_ONLY_SET: ReadonlySet<string> = new Set(READ_ONLY_METHODS);

export class MezoRpc {
  private readonly opts: Required<Omit<RpcOptions, "fetchImpl" | "sleepImpl">> & Pick<RpcOptions, "fetchImpl" | "sleepImpl">;
  private nextId = 1;

  constructor(opts: RpcOptions) {
    this.opts = {
      timeoutMs: opts.timeoutMs ?? RPC_LIMITS.DEFAULT_TIMEOUT_MS,
      maxRetries: opts.maxRetries ?? RPC_LIMITS.DEFAULT_MAX_RETRIES,
      backoffMs: opts.backoffMs ?? RPC_LIMITS.DEFAULT_BACKOFF_MS,
      url: opts.url,
      fetchImpl: opts.fetchImpl,
      sleepImpl: opts.sleepImpl,
    };
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    if (!READ_ONLY_SET.has(method)) {
      // Structural guard, not a convention: this client cannot broadcast.
      throw new RpcError(`refusing non-read-only method ${method}`, undefined, false);
    }
    const body = JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params });
    let lastErr: RpcError | undefined;
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = this.opts.backoffMs * 2 ** (attempt - 1);
        await (this.opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(delay);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
      try {
        const res = await (this.opts.fetchImpl ?? fetch)(this.opts.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: controller.signal,
        });
        if (!res.ok) {
          const retryable = isRetryableStatus(res.status);
          lastErr = new RpcError(`${method} HTTP ${res.status}`, res.status, retryable);
          if (!retryable) throw lastErr;
          continue;
        }
        const json = (await res.json()) as { result?: T; error?: { code?: number; message?: string } };
        if (json.error) {
          // A JSON-RPC error is a protocol answer, not a transient fault. Do not retry.
          throw new RpcError(`${method}: ${json.error.message ?? "rpc error"}`, json.error.code, false);
        }
        if (json.result === undefined) throw new RpcError(`${method}: response has no result`);
        return json.result;
      } catch (err) {
        if (err instanceof RpcError) {
          if (!err.retryable) throw err;
          lastErr = err;
          continue;
        }
        lastErr = new RpcError(`${method}: ${(err as Error).message}`, undefined, true);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr ?? new RpcError(`${method} failed`);
  }

  async chainId(): Promise<MezoChainId> {
    const raw = await this.call<string>("eth_chainId", []);
    const id = Number(parseQuantity(raw, "eth_chainId"));
    if (id !== 31611 && id !== 31612) throw new RpcError(`Unsupported chain id ${id}`);
    return id as MezoChainId;
  }

  async blockNumber(): Promise<number> {
    const raw = await this.call<string>("eth_blockNumber", []);
    const n = parseQuantity(raw, "eth_blockNumber");
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new RpcError("eth_blockNumber exceeds safe integer range");
    return Number(n);
  }

  async getBlock(number: number): Promise<RpcBlock | null> {
    const raw = await this.call<{ number: string; hash: string; parentHash: string } | null>("eth_getBlockByNumber", [toQuantity(number), false]);
    if (raw === null) return null;
    return { number: raw.number, hash: normalizeHex(raw.hash), parentHash: normalizeHex(raw.parentHash) };
  }

  /**
   * `eth_getCode` — read-only. Returns the deployed bytecode, or `0x` when no
   * contract is deployed at the address.
   *
   * The returned bytes are the runtime code exactly as the node serves it. They
   * are NOT proof of source verification: compiler metadata, immutable values
   * baked in at construction and library links all differ from the artifact
   * bytecode, so a hash comparison against a local build is not a verification
   * claim.
   */
  async getCode(address: Address): Promise<Hex> {
    const raw = await this.call<string>("eth_getCode", [normalizeAddress(address), "latest"]);
    if (typeof raw !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(raw)) {
      throw new RpcError("eth_getCode did not return canonical hex");
    }
    return raw.toLowerCase() as Hex;
  }

  /**
   * `eth_call` — read-only, never a transaction. Returns raw return data.
   *
   * There is deliberately no send/sign/permit method on this client: the type
   * surface itself makes a state-changing call unrepresentable.
   */
  async callContract(to: Address, data: Hex): Promise<Hex> {
    const raw = await this.call<string>("eth_call", [{ to: normalizeAddress(to), data }, "latest"]);
    if (typeof raw !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(raw)) {
      throw new RpcError("eth_call did not return canonical hex");
    }
    return raw.toLowerCase() as Hex;
  }

  /**
   * Fetch logs for a bounded range. The range is clamped to
   * `RPC_LIMITS.MAX_BLOCK_RANGE` and the result count to
   * `RPC_LIMITS.MAX_LOGS_PER_CALL`; exceeding either is an error, not a silent
   * truncation, because a truncated page would look like "no more logs".
   */
  async getLogs(args: { address: Address; topics: readonly Hex[]; fromBlock: number; toBlock: number }): Promise<RpcLog[]> {
    const span = args.toBlock - args.fromBlock + 1;
    if (span <= 0) throw new RpcError("getLogs range is empty or inverted");
    if (span > RPC_LIMITS.MAX_BLOCK_RANGE) {
      throw new RpcError(`getLogs range ${span} exceeds the ${RPC_LIMITS.MAX_BLOCK_RANGE}-block cap`);
    }
    const raw = await this.call<unknown[]>("eth_getLogs", [
      {
        address: normalizeAddress(args.address),
        topics: [args.topics.map((t) => t.toLowerCase())],
        fromBlock: toQuantity(args.fromBlock),
        toBlock: toQuantity(args.toBlock),
      },
    ]);
    if (!Array.isArray(raw)) throw new RpcError("eth_getLogs did not return an array");
    if (raw.length > RPC_LIMITS.MAX_LOGS_PER_CALL) {
      throw new RpcError(`eth_getLogs returned ${raw.length} logs, above the ${RPC_LIMITS.MAX_LOGS_PER_CALL} cap; narrow the range`);
    }
    return raw.map((v, i) => validateLog(v, i));
  }
}

const validateLog = (v: unknown, i: number): RpcLog => {
  if (typeof v !== "object" || v === null) throw new RpcError(`log[${i}] is not an object`);
  const l = v as Record<string, unknown>;
  const str = (k: string): string => {
    const val = l[k];
    if (typeof val !== "string") throw new RpcError(`log[${i}].${k} is not a string`);
    return val;
  };
  const nullableStr = (k: string): string | null => {
    const val = l[k];
    if (val === null || val === undefined) return null;
    if (typeof val !== "string") throw new RpcError(`log[${i}].${k} is not a string or null`);
    return val;
  };
  const topics = l.topics;
  if (!Array.isArray(topics) || topics.some((t) => typeof t !== "string")) {
    throw new RpcError(`log[${i}].topics is not a string array`);
  }
  return {
    address: str("address"),
    topics: topics as string[],
    data: str("data"),
    blockNumber: str("blockNumber"),
    blockHash: nullableStr("blockHash"),
    transactionHash: nullableStr("transactionHash"),
    transactionIndex: nullableStr("transactionIndex"),
    logIndex: str("logIndex"),
    removed: l.removed === true,
  };
};
