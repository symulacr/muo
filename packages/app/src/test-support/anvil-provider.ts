// EIP-1193 adapter over a REAL local anvil JSON-RPC endpoint.
//
// Purpose: let the portal's actual transaction orchestration (`lib/mezo-tx.ts`)
// run against a real chain instead of a mock. The adapter forwards every method
// verbatim to anvil and only intercepts the account-selection methods so a test
// can choose which UNLOCKED anvil account is "the user".
//
// Scope and non-claims:
//  - LOCAL ONLY. This is an anvil dev chain, not Mezo and not a browser wallet.
//  - No private key is ever handled: anvil signs `eth_sendTransaction` for its
//    own unlocked accounts. Nothing here reads or logs key material.
//  - This is a provider adapter, NOT a real browser extension and NOT evidence
//    of a live Mezo wallet flow.

import type { Address } from "@muo/core/native";

import type { Eip1193Provider } from "@/lib/wallet-eip1193";

type JsonRpcResponse = { result?: unknown; error?: { message: string; code: number; data?: unknown } };

/** Methods whose result is derived from the adapter's selected-account state. */
const ACCOUNT_METHODS = new Set(["eth_accounts", "eth_requestAccounts"]);

export type AnvilProviderOptions = {
  url: string;
  /** Unlocked anvil accounts the adapter may expose. */
  accounts: readonly Address[];
  /** Index into `accounts` that represents the connected user. */
  selectedIndex?: number;
  /** When true, `eth_requestAccounts` behaves as if the user rejected. */
  rejectConnect?: boolean;
};

export class AnvilProvider implements Eip1193Provider {
  readonly url: string;
  readonly available: readonly Address[];
  #selectedIndex: number;
  rejectConnect: boolean;
  /** Every forwarded method, in order. Lets tests assert call ordering. */
  readonly calls: string[] = [];
  #handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  #id = 0;

  constructor(opts: AnvilProviderOptions) {
    this.url = opts.url;
    this.available = opts.accounts;
    this.#selectedIndex = opts.selectedIndex ?? 0;
    this.rejectConnect = opts.rejectConnect ?? false;
  }

  get selected(): Address {
    const account = this.available[this.#selectedIndex];
    if (!account) throw new Error("AnvilProvider: no account selected");
    return account;
  }

  /** Switch which unlocked account the adapter reports as connected. */
  selectAccount(index: number): void {
    if (index < 0 || index >= this.available.length) throw new RangeError("AnvilProvider: account index out of range");
    this.#selectedIndex = index;
    this.emit("accountsChanged", [this.selected]);
  }

  async request({ method, params }: { method: string; params?: unknown[] | object }): Promise<unknown> {
    this.calls.push(method);

    if (ACCOUNT_METHODS.has(method)) {
      if (method === "eth_requestAccounts" && this.rejectConnect) {
        throw Object.assign(new Error("User rejected the request."), { code: 4001 });
      }
      return [this.selected];
    }

    // `eth_sendTransaction` is forwarded WITHOUT a `from` override so anvil signs
    // as the requested sender; the caller always sets `from` explicitly.
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++this.#id, method, params: params ?? [] });
    const res = await fetch(this.url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    if (!res.ok) throw new Error(`anvil HTTP ${res.status} for ${method}`);
    const json = (await res.json()) as JsonRpcResponse;
    if (json.error) throw Object.assign(new Error(`${method}: ${json.error.message}`), { code: json.error.code, data: json.error.data });
    return json.result;
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    const set = this.#handlers.get(event) ?? new Set();
    set.add(handler);
    this.#handlers.set(event, set);
  }

  removeListener(event: string, handler: (...args: unknown[]) => void): void {
    this.#handlers.get(event)?.delete(handler);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.#handlers.get(event) ?? []) handler(...args);
  }

  /** Number of times a method was forwarded or intercepted. */
  count(method: string): number {
    return this.calls.filter((m) => m === method).length;
  }
}
