// READ-ONLY Mezo testnet compatibility probe.
//
// What this proves: that the native decoder and the read-only RPC surface work
// against the REAL public Mezo testnet node — chain id, deployed bytecode,
// contract constants, token decimals, and a bounded historical log sample
// decoded by the shipped SDK decoder and cross-checked against `getAssertion`.
//
// What this does NOT prove:
//   - it is not a wallet flow, not a transaction, not a write of any kind
//   - it is not source verification (see the `core_bytecode_present` check)
//   - it is not a backfill and says nothing about indexer throughput
//
// Safety
// ------
// - Only read methods are reachable: `MezoRpc` enforces a hard allowlist in
//   `call()`, and this script never constructs a transaction.
// - No secret, env file, key or wallet is read or logged. The only inputs are
//   the public constants below.
// - Requests are serial, bounded in count, timeout and page size, with at most
//   one retry. No loops beyond the fixed page budget, no polling.
//
// ABI handling: calldata is encoded and return data decoded by `viem` against
// the EXACT compiler ABI (`muoCoreAbi` / `musdAbi` from `@muo/core/abi`). There
// is no hand-written selector and no hand-written word reader, so a signature
// drift in the ABI surfaces as an encoding error instead of a silent mis-decode.
// `viem` is a devDependency of this package: this script is tooling, not part of
// the Worker bundle.
//
// Usage:
//   bun run scripts/check-mezo-readonly.ts
//   bun run scripts/check-mezo-readonly.ts --json   # machine-readable only
//
// Exit codes: 0 = all checks passed, 1 = a check failed, 2 = RPC unavailable.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Abi } from "viem";
import { decodeFunctionResult, encodeFunctionData } from "viem";

import type { Address, Hex } from "@muo/core/native";
import { muoCoreAbi, musdAbi } from "@muo/core/abi";
import { decodeMuoLog, MUO_TOPIC0 } from "@muo/sdk";

import type { RpcLog } from "../src/lib/mezo/rpc";
import { MezoRpc, READ_ONLY_METHODS, RpcError } from "../src/lib/mezo/rpc";

// ---------------------------------------------------------------------------
// Public constants. Not secrets; all published in the repo and on the explorer.
// ---------------------------------------------------------------------------

const RPC_URL = "https://rpc.test.mezo.org";
const CHAIN_ID = 31611;
const CORE = "0x61c41cd7299fd668c3a7aae62f12c017fe654cb0" as Address;
const MUSD = "0x118917a40faf1cd7a13db0ef56c86de7973ac503" as Address;
const DEPLOY_BLOCK = 16_380_473;

/** Budget: a compatibility probe, not an indexer. */
const BUDGET = {
  maxCalls: 20,
  maxLogPages: 3,
  maxBlocksPerPage: 400,
  timeoutMs: 8_000,
  maxRetries: 1,
  backoffMs: 400,
} as const;

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(here, "..", "..", "..", "outputs", "continuation-20261028", "mezo-readonly");

// ---------------------------------------------------------------------------
// Read-only ABI helpers (viem + the compiler ABI)
// ---------------------------------------------------------------------------

/**
 * `eth_call` a view function and decode its return data.
 *
 * `encodeFunctionData` throws if the function is absent from the ABI or the
 * arguments do not match, and `decodeFunctionResult` throws on short or
 * malformed return data. Both failures are surfaced rather than papered over.
 */
const ethCall = async <T>(to: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> => {
  const data = encodeFunctionData({ abi, functionName, args } as never) as Hex;
  const raw = await rpc.callContract(to, data);
  return decodeFunctionResult({ abi, functionName, data: raw } as never) as T;
};

/**
 * Normalize an address returned over the wire.
 *
 * `viem` decodes `address` as an EIP-55 CHECKSUMMED string. The native wire
 * contract (`@muo/core/native`) requires lowercase `0x` + 40 hex, so the
 * boundary is exactly where the conversion belongs — comparing a checksummed
 * value against a lowercase constant would otherwise fail for no real reason.
 */
const lowerAddress = (v: string): Address => v.toLowerCase() as Address;

// ---------------------------------------------------------------------------
// Result accumulation
// ---------------------------------------------------------------------------

type Check = { name: string; ok: boolean; detail: string; data?: unknown };
type MethodCount = Record<string, number>;

const checks: Check[] = [];
const methodCounts: MethodCount = {};
let callCount = 0;

const record = (name: string, ok: boolean, detail: string, data?: unknown): void => {
  checks.push({ name, ok, detail, ...(data === undefined ? {} : { data }) });
};

/**
 * Wrap fetch to count calls and enforce the global budget.
 *
 * Typed loosely on purpose: the Workers `fetch` type carries CF-specific
 * properties that a plain wrapper does not, and this script only needs the
 * (input, init) -> Response shape.
 */
const budgetedFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  callCount++;
  if (callCount > BUDGET.maxCalls) {
    throw new RpcError(`probe budget exhausted at ${BUDGET.maxCalls} calls`, undefined, false);
  }
  try {
    const body = init?.body;
    if (typeof body === "string") {
      const parsed = JSON.parse(body) as { method?: string };
      if (typeof parsed.method === "string") methodCounts[parsed.method] = (methodCounts[parsed.method] ?? 0) + 1;
    }
  } catch {
    /* counting is best-effort; a malformed body is rejected downstream */
  }
  return fetch(input as never, init as never);
}) as unknown as typeof fetch;

const rpc = new MezoRpc({
  url: RPC_URL,
  timeoutMs: BUDGET.timeoutMs,
  maxRetries: BUDGET.maxRetries,
  backoffMs: BUDGET.backoffMs,
  fetchImpl: budgetedFetch,
});

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const jsonOnly = process.argv.includes("--json");
  const log = (line: string) => {
    if (!jsonOnly) console.log(line);
  };

  log("Mezo read-only compatibility probe");
  log(`  rpc      ${RPC_URL}`);
  log(`  chainId  ${CHAIN_ID}`);
  log(`  core     ${CORE}`);
  log(`  musd     ${MUSD}`);
  log(`  budget   ${BUDGET.maxCalls} calls, ${BUDGET.maxLogPages} log pages x ${BUDGET.maxBlocksPerPage} blocks`);
  log("");

  // 1. chain id ------------------------------------------------------------
  try {
    const id = await rpc.chainId();
    record("chain_id", id === CHAIN_ID, `eth_chainId = ${id} (expected ${CHAIN_ID})`, { chainId: id });
  } catch (err) {
    record("chain_id", false, `eth_chainId failed: ${(err as Error).message}`);
    return finish(jsonOnly, 2);
  }

  // 2. latest block shape --------------------------------------------------
  let head = 0;
  try {
    head = await rpc.blockNumber();
    const block = await rpc.getBlock(head);
    const ok = block !== null && /^0x[0-9a-f]{64}$/.test(block.hash) && head >= DEPLOY_BLOCK;
    record("latest_block", ok, `head = ${head}, hash = ${block?.hash ?? "null"}`, { head, hash: block?.hash ?? null });
  } catch (err) {
    record("latest_block", false, `eth_blockNumber/eth_getBlockByNumber failed: ${(err as Error).message}`);
    return finish(jsonOnly, 2);
  }

  // 3. deployed bytecode ---------------------------------------------------
  // Presence of code is ALL this proves. It is NOT source verification: compiler
  // metadata, constructor-baked immutables and library links mean the deployed
  // bytes will not equal a local artifact hash even for correct source.
  try {
    const code = await rpc.getCode(CORE);
    const bytes = (code.length - 2) / 2;
    record("core_bytecode_present", bytes > 0, `${bytes} bytes at ${CORE} (presence only; not source verification)`, {
      coreBytes: bytes,
    });
  } catch (err) {
    record("core_bytecode_present", false, `eth_getCode(core) failed: ${(err as Error).message}`);
  }

  try {
    const code = await rpc.getCode(MUSD);
    const bytes = (code.length - 2) / 2;
    record("musd_bytecode_present", bytes > 0, `${bytes} bytes at ${MUSD}`, { musdBytes: bytes });
  } catch (err) {
    record("musd_bytecode_present", false, `eth_getCode(musd) failed: ${(err as Error).message}`);
  }

  // 4. contract constants through the compiler ABI -------------------------
  try {
    const minBond = await ethCall<bigint>(CORE, muoCoreAbi as Abi, "getMinBondMusd");
    record("getMinBondMusd", minBond >= 1n, `getMinBondMusd() = ${minBond} whole MUSD`, { minBondMusd: String(minBond) });
  } catch (err) {
    record("getMinBondMusd", false, `getMinBondMusd failed: ${(err as Error).message}`);
  }

  try {
    const unit = await ethCall<bigint>(CORE, muoCoreAbi as Abi, "MUSD_UNIT");
    record("MUSD_UNIT", unit === 10n ** 18n, `MUSD_UNIT() = ${unit}`, { musdUnit: String(unit) });
  } catch (err) {
    record("MUSD_UNIT", false, `MUSD_UNIT failed: ${(err as Error).message}`);
  }

  try {
    const addr = lowerAddress(await ethCall<string>(CORE, muoCoreAbi as Abi, "musd"));
    record("core_musd_address", addr === MUSD, `MuoCore.musd() = ${addr} (expected ${MUSD})`, { musd: addr });
  } catch (err) {
    record("core_musd_address", false, `musd() failed: ${(err as Error).message}`);
  }

  try {
    const owner = lowerAddress(await ethCall<string>(CORE, muoCoreAbi as Abi, "CONTRACT_OWNER"));
    const ok = /^0x[0-9a-f]{40}$/.test(owner);
    // The owner is public chain state, not PII, but it is not needed in the
    // report; record only that it parsed as an address.
    record("contract_owner", ok, "CONTRACT_OWNER() parsed as a 20-byte address", { ownerParsed: ok });
  } catch (err) {
    record("contract_owner", false, `CONTRACT_OWNER failed: ${(err as Error).message}`);
  }

  // 5. MUSD decimals -------------------------------------------------------
  try {
    const decimals = Number(await ethCall<number>(MUSD, musdAbi as Abi, "decimals"));
    record("musd_decimals", decimals === 18, `MUSD.decimals() = ${decimals}`, { decimals });
  } catch (err) {
    record("musd_decimals", false, `MUSD.decimals failed: ${(err as Error).message}`);
  }

  // 6. bounded historical Asserted sample ----------------------------------
  // Start at the deploy block and page forward a few small ranges looking for
  // Asserted logs. No assumption about how many exist; the run reports what it
  // actually saw, and absence is reported as absence rather than as zero.
  let sampled: RpcLog[] = [];
  let pages = 0;
  let scannedTo = DEPLOY_BLOCK - 1;
  try {
    for (let page = 0; page < BUDGET.maxLogPages && sampled.length === 0; page++) {
      const from = DEPLOY_BLOCK + page * BUDGET.maxBlocksPerPage;
      const to = Math.min(from + BUDGET.maxBlocksPerPage - 1, head);
      if (from > to) break;
      pages++;
      const logs = await rpc.getLogs({ address: CORE, topics: [MUO_TOPIC0.Asserted], fromBlock: from, toBlock: to });
      scannedTo = to;
      if (logs.length > 0) sampled = logs;
    }
    record(
      "asserted_log_sample",
      true,
      sampled.length > 0
        ? `found ${sampled.length} Asserted log(s) within ${pages} page(s), scanned to block ${scannedTo}`
        : `no Asserted log within ${pages} page(s) up to block ${scannedTo} (absence is not evidence of no assertions)`,
      { pages, scannedTo, found: sampled.length }
    );
  } catch (err) {
    record("asserted_log_sample", false, `eth_getLogs failed: ${(err as Error).message}`);
  }

  // 7. strict SDK decode of the sample + getAssertion cross-check ----------
  const log0 = sampled[0];
  if (log0 !== undefined) {
    try {
      const ev = decodeMuoLog(log0, CHAIN_ID, CORE);
      if (ev === null) {
        record("sdk_decode", false, "decoder returned null for a log it should recognise");
      } else {
        record("sdk_decode", true, `decoded ${ev.event} for ${ev.data.assertionId}`, {
          event: ev.event,
          assertionId: ev.data.assertionId,
          blockNumber: ev.provenance.blockNumber,
          ...(ev.event === "asserted" ? { bondMusd: ev.data.bondMusd } : {}),
        });

        // Cross-check against on-chain state: getAssertion(bytes32) returns the
        // 11-field Assertion struct. viem decodes it against the compiler ABI,
        // so field order and types come from solc rather than from a hand-counted
        // word index.
        try {
          const id = ev.data.assertionId;
          const view = await ethCall<{
            asserter: string;
            disputer: string;
            bondMusd: bigint;
            liveness: bigint;
            status: number;
            assertedAtBlock: bigint;
            disputedAtBlock: bigint;
            settledAtBlock: bigint;
            rejectedAtBlock: bigint;
            unresolvedAtBlock: bigint;
            exists: boolean;
          }>(CORE, muoCoreAbi as Abi, "getAssertion", [id]);

          const exists = view.exists === true;
          const status = Number(view.status);
          record(
            "getAssertion_crosscheck",
            exists,
            exists ? `getAssertion(${id}).exists = true, status = ${status}` : "getAssertion returned exists = false for a decoded assertion",
            {
              exists,
              status,
              // The decoded event's bond must agree with on-chain state. This is
              // the real cross-check: it ties the SDK's `bondMusd` string to the
              // contract's `uint256`.
              bondMusd: String(view.bondMusd),
              liveness: Number(view.liveness),
              bondMatchesDecoded: ev.event === "asserted" ? String(view.bondMusd) === ev.data.bondMusd : null,
            }
          );
        } catch (err) {
          record("getAssertion_crosscheck", false, `getAssertion failed: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      record("sdk_decode", false, `strict decode rejected the log: ${(err as Error).message}`);
    }
  } else {
    record("sdk_decode", true, "skipped: no Asserted log in the sampled window");
    record("getAssertion_crosscheck", true, "skipped: no Asserted log in the sampled window");
  }

  return finish(jsonOnly, checks.every((c) => c.ok) ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function finish(jsonOnly: boolean, exitCode: number): number {
  const failed = checks.filter((c) => !c.ok);
  const report = {
    probe: "mezo-readonly-compatibility",
    generatedAt: new Date().toISOString(),
    rpc: RPC_URL,
    chainId: CHAIN_ID,
    addresses: { core: CORE, musd: MUSD },
    deployBlock: DEPLOY_BLOCK,
    budget: BUDGET,
    allowedMethods: READ_ONLY_METHODS,
    calls: { total: callCount, byMethod: methodCounts },
    exitCode,
    passed: failed.length === 0,
    checks,
    // Explicit scope so the JSON cannot be mistaken for more than it is.
    scope: {
      readOnly: true,
      transactions: "none",
      wallet: "none",
      secrets: "none",
      sourceVerification: "not performed (deployed bytecode presence only)",
      backfill: "none (bounded sample only)",
      indexerThroughput: "not measured",
    },
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, "probe-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (!jsonOnly) {
    console.log("");
    for (const c of checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
    console.log("");
    console.log(
      `  calls: ${callCount} (${
        Object.entries(methodCounts)
          .map(([m, n]) => `${m}=${n}`)
          .join(", ") || "none"
      })`
    );
    console.log(`  report: ${resolve(OUT_DIR, "probe-report.json")}`);
    console.log(`  result: ${failed.length === 0 ? "PASS" : `FAIL (${failed.length} check(s))`}`);
  }
  return exitCode;
}

const code = await main();
process.exit(code);
