// Smoke: real Hono API + real SQLite D1 + real indexer against a local anvil.
// Proves the pipeline end-to-end without a browser or Next build.
//
//   bun --no-env-file src/test-support/browser/real-api-smoke.ts

import { MuoCoreClient, MusdClient } from "@muo/integration/contracts";
import { deploy, loadArtifact, mockMusdArtifact, send } from "@muo/integration/deploy";
import { startAnvil } from "@muo/integration/fixture";
import { computeAssertionId } from "@muo/utils/native";

import { startRealApi } from "./real-api";

const CHAIN_ID = 31611;
const BOND = 10n;
const MUSD_UNIT = 10n ** 18n;
const CLAIM = `0x${"cc".repeat(64)}` as `0x${string}`;

const fx = await startAnvil({ chainId: CHAIN_ID });
let api: Awaited<ReturnType<typeof startRealApi>> | null = null;
try {
  const [owner, asserter] = fx.accounts as [string, string];

  const musdArtifact = mockMusdArtifact();
  const musdAddr = await deploy(fx.rpc, owner, musdArtifact.abi, musdArtifact.bytecode);
  const musd = new MusdClient(fx.rpc, musdAddr as `0x${string}`, musdArtifact.abi);

  const coreArtifact = loadArtifact("MuoCore", "MuoCore");
  const coreAddr = await deploy(fx.rpc, owner, coreArtifact.abi, coreArtifact.bytecode, [musdAddr]);

  await send(fx.rpc, owner, musdAddr, musd.mintData(asserter, 1_000n * MUSD_UNIT));

  const startBlock = Number(BigInt(await fx.rpc.blockNumber()));

  api = await startRealApi({ chainId: CHAIN_ID, coreAddress: coreAddr, rpcUrl: fx.url, startBlock, confirmations: 0 });

  // Baseline: real API, real D1, no rows yet. Read with the cache bypassed.
  const before = await api.readAssertions();

  // Perform a real assertion on the real chain.
  const identifier = computeAssertionId(`0x${"11".repeat(32)}`, CLAIM, BOND, 5n, 0n);
  await send(fx.rpc, asserter, musdAddr, musd.approveData(coreAddr, BOND * MUSD_UNIT));
  const { receipt } = await send(fx.rpc, asserter, coreAddr, MuoCoreClient.assertClaimData(identifier, CLAIM, BOND, 5n));

  // Real indexer cycle, bounded, explicit. Awaited BEFORE the read, so the
  // request ordering cannot be mistaken for a DB bug.
  const indexed = await api.runIndexer();

  const after = await api.readAssertions();
  const status = (await (await fetch(`${api.url}/v2/status`, { cache: "no-store" })).json()) as {
    state?: string;
    counts?: { assertions?: number; appliedLogs?: number };
  };

  console.log(
    JSON.stringify(
      {
        beforeRows: before.length,
        indexerResult: indexed,
        afterRows: after.length,
        firstRow: after[0]
          ? {
              id: (after[0] as { id?: string }).id,
              bondMusd: (after[0] as { bondMusd?: string }).bondMusd,
              status: (after[0] as { status?: string }).status,
              asserter: (after[0] as { asserter?: string }).asserter,
            }
          : null,
        statusState: status.state,
        statusCounts: status.counts,
        d1RowCount: await api.countRows(),
        assertedBlock: receipt.blockNumber,
      },
      null,
      2
    )
  );
} finally {
  await api?.stop();
  await fx.stop();
}
