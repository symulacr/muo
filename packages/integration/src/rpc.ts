// Minimal raw JSON-RPC transport for the MuoCore integration harness.
//
// Scope: transport ONLY. This module speaks JSON-RPC 2.0 over `fetch` and
// exposes typed wrappers for the handful of methods the suite calls. It performs
// NO ABI encoding or decoding — all of that is delegated to viem in
// ./contracts.ts and ./deploy.ts against the real ABIs (muoCoreAbi from
// @muo/core/abi, plus the locally compiled MockMUSD artifact ABI).
//
// Why keep a raw transport at all: it lets the suite drive anvil-specific
// methods (`evm_mine`, `evm_setNextBlockTimestamp`) and inspect raw receipts and
// logs without bending viem's higher-level client, and it keeps the fixture's
// startup readiness probe dependency-light. viem's own `custom` transport could
// be pointed here later if the harness moves fully onto viem clients.
//
// viem@2.57.7 IS installed and is the encoder/decoder of record.

export type Hex = `0x${string}`;

export type RpcLog = {
  address: string;
  topics: readonly string[];
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  transactionIndex: string;
  logIndex: string;
  removed?: boolean;
};

export type RpcReceipt = {
  transactionHash: Hex;
  blockNumber: Hex;
  blockHash: Hex;
  status: Hex;
  from: Hex;
  to: Hex | null;
  contractAddress: Hex | null;
  gasUsed: Hex;
  logs: RpcLog[];
};

export type RpcBlock = { number: Hex; hash: Hex; timestamp: Hex };

export type RpcTx = { hash: Hex; blockNumber: Hex | null; from: Hex; to: Hex | null; input: Hex };

export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(message: string, code: number, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

/** A JSON-RPC client bound to one HTTP endpoint. */
export class RpcClient {
  readonly url: string;
  #id = 0;

  constructor(url: string) {
    this.url = url;
  }

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++this.#id, method, params });
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) throw new RpcError(`HTTP ${res.status} for ${method}`, res.status);
    const json = (await res.json()) as { result?: T; error?: { message: string; code: number; data?: unknown } };
    if (json.error) throw new RpcError(`${method}: ${json.error.message}`, json.error.code, json.error.data);
    return json.result as T;
  }

  // --- convenience wrappers -------------------------------------------

  chainId = () => this.call<string>("eth_chainId");
  accounts = () => this.call<Hex[]>("eth_accounts");
  blockNumber = () => this.call<Hex>("eth_blockNumber");
  getBlock = (tag: string) => this.call<RpcBlock | null>("eth_getBlockByNumber", [tag, false]);
  getBalance = (addr: string) => this.call<Hex>("eth_getBalance", [addr, "latest"]);
  getCode = (addr: string) => this.call<Hex>("eth_getCode", [addr, "latest"]);
  getTransaction = (hash: string) => this.call<RpcTx | null>("eth_getTransactionByHash", [hash]);
  getReceipt = (hash: string) => this.call<RpcReceipt | null>("eth_getTransactionReceipt", [hash]);

  sendTransaction = (tx: Record<string, unknown>) => this.call<Hex>("eth_sendTransaction", [tx]);

  ethCall = (to: string, data: Hex) => this.call<Hex>("eth_call", [{ to, data }, "latest"]);

  getLogs = (filter: { address?: string; fromBlock?: string; toBlock?: string; topics?: (string | null)[] }) => this.call<RpcLog[]>("eth_getLogs", [filter]);

  /** Advance the chain by `n` empty blocks. */
  async mine(n = 1): Promise<void> {
    for (let i = 0; i < n; i++) {
      await this.call("evm_mine", []);
    }
  }

  /** Set the next block timestamp (seconds). */
  setNextTimestamp = (seconds: number) => this.call<string>("evm_setNextBlockTimestamp", [seconds]);

  /** Poll until `predicate` returns a value, bounded by `timeoutMs`. */
  async waitFor<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs: number, label: string): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const v = await fn();
        if (v) return v as T;
      } catch (err) {
        lastError = err;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}${lastError ? `: ${String(lastError)}` : ""}`);
  }

  /** Wait for a receipt, bounded. Returns the receipt or throws. */
  async waitForReceipt(hash: string, timeoutMs = 20_000): Promise<RpcReceipt> {
    return this.waitFor(
      async () => {
        const r = await this.getReceipt(hash);
        return r?.blockNumber ? r : undefined;
      },
      timeoutMs,
      `receipt ${hash}`
    );
  }
}
