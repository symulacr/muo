import type { Assertion } from "@muo/core/native";

export const TEST_ACCOUNT_A = "0x1111111111111111111111111111111111111111";
export const TEST_ACCOUNT_B = "0x9999999999999999999999999999999999999999";

/** Canonical v2 assertion row fixture. Overrides let tests target one wire field at a time. */
export const makeRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: `0x${"ab".repeat(32)}`,
  identifier: `0x${"cd".repeat(32)}`,
  claim: "0x48656c6c6f",
  bondMusd: "10",
  liveness: 1440,
  status: "open",
  asserter: TEST_ACCOUNT_A,
  disputer: null,
  settler: null,
  resolver: null,
  assertedAtBlock: 100,
  assertedTxId: `0x${"ee".repeat(32)}`,
  disputedAtBlock: null,
  disputedTxId: null,
  settledAtBlock: null,
  settledTxId: null,
  resolvedAtBlock: null,
  resolvedTxId: null,
  chainId: 31611,
  coreAddress: "0x3333333333333333333333333333333333333333",
  blockNumber: 101,
  blockHash: `0x${"ff".repeat(32)}`,
  transactionIndex: 0,
  logIndex: 0,
  ...overrides,
});

export const makeAssertion = (overrides: Record<string, unknown> = {}): Assertion => makeRow(overrides) as unknown as Assertion;
