import type { Address, Hex } from "@muo/core/native";

import type { Eip1193Provider } from "@/lib/wallet-eip1193";

export type RequestRecord = { method: string; params?: unknown };

export const TEST_ACCOUNT = "0x1111111111111111111111111111111111111111" as Address;
export const OTHER_ACCOUNT = "0x2222222222222222222222222222222222222222" as Address;
export const TEST_CORE = "0x3333333333333333333333333333333333333333" as Address;
export const TEST_MUSD = "0x4444444444444444444444444444444444444444" as Address;
export const TEST_ID = `0x${"ab".repeat(32)}` as Hex;
export const TEST_TX = `0x${"cd".repeat(32)}` as Hex;

/**
 * Controllable EIP-1193 provider for tests.
 *
 * Models chain id, accounts, and a per-method response queue so tests can drive
 * connect / cancel / wrong-chain / account-change paths deterministically.
 */
export class FakeProvider implements Eip1193Provider {
  chainId: number;
  accounts: Address[];
  requests: RequestRecord[] = [];
  private handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  private overrides = new Map<string, Array<() => Promise<unknown>>>();

  constructor(opts: { chainId?: number; accounts?: Address[] } = {}) {
    this.chainId = opts.chainId ?? 31611;
    this.accounts = opts.accounts ?? [];
  }

  /** Queue a one-shot behaviour for a method (throw or custom result). */
  queue(method: string, fn: () => Promise<unknown>): void {
    const list = this.overrides.get(method) ?? [];
    list.push(fn);
    this.overrides.set(method, list);
  }

  async request({ method, params }: { method: string; params?: unknown[] | object }): Promise<unknown> {
    this.requests.push({ method, params });
    const queued = this.overrides.get(method);
    if (queued && queued.length > 0) {
      const next = queued.shift() as () => Promise<unknown>;
      return next();
    }
    switch (method) {
      case "eth_chainId":
        return `0x${this.chainId.toString(16)}`;
      case "eth_accounts":
        return this.accounts;
      case "eth_requestAccounts":
        if (this.accounts.length === 0) throw Object.assign(new Error("User rejected request"), { code: 4001 });
        return this.accounts;
      case "wallet_switchEthereumChain": {
        const target = (params as Array<{ chainId: string }>)[0]?.chainId;
        if (!target) throw new Error("missing chainId");
        this.chainId = Number.parseInt(target, 16);
        return null;
      }
      case "wallet_addEthereumChain":
        return null;
      case "eth_sendTransaction":
        return TEST_TX;
      case "eth_blockNumber":
        return "0x10";
      case "eth_call":
        return "0x";
      default:
        throw new Error(`FakeProvider: unsupported method ${method}`);
    }
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler);
    this.handlers.set(event, set);
  }

  removeListener(event: string, handler: (...args: unknown[]) => void): void {
    this.handlers.get(event)?.delete(handler);
  }

  /** Emits a provider event to registered listeners. */
  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}
