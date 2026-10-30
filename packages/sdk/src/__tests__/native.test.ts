import { describe, expect, test } from "bun:test";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";
import { decodeEventLog, getAbiItem, toEventSelector } from "viem";

import type { Address, Hex } from "@muo/core/native";
import { muoCoreAbi } from "@muo/core/abi";
import { isAssertionEvent, isBondMusdWire, TESTNET_CORE } from "@muo/core/native";
import { computeAssertionId } from "@muo/utils/native";

import type { RpcLog } from "../native";
import { decodeMuoLog, isMuoTopic, MUO_EVENT_NAMES, MUO_EVENT_SIGNATURES, MUO_TOPIC0, MuoLogDecodeError } from "../native";

const CHAIN = 31611 as const;
const CORE = TESTNET_CORE as Address;
const ACTOR = "0x2a2a8551e30c63263dd9dbb698e57fb37c77a6b3" as Address;
const OTHER_ACTOR = "0x118917a40faf1cd7a13db0ef56c86de7973ac503" as Address;
const IDENTIFIER = `0x${"11".repeat(32)}` as Hex;
const CLAIM = "0xdeadbeef" as Hex;
const BLOCK = 16_380_473;
const BLOCK_HASH = `0x${"bb".repeat(32)}` as Hex;
const TX_HASH = `0x${"cc".repeat(32)}` as Hex;

const pad32 = (hex: Hex): string => hex.slice(2).padStart(64, "0");
const word = (n: bigint): string => n.toString(16).padStart(64, "0");
const topicOf = (hex: Hex): string => `0x${hex.slice(2).padStart(64, "0")}`;
const addrTopic = (addr: Address): string => `0x${addr.slice(2).padStart(64, "0")}`;
/** abi.encode(bytes) tail: length word + zero-padded data words. */
const bytesTail = (hex: Hex): string => {
  const body = hex.slice(2);
  const len = body.length / 2;
  const padded = body.padEnd(Math.ceil(len / 32) * 64, "0");
  return word(BigInt(len)) + padded;
};

const assertedData = (identifier: Hex, claim: Hex, bond: bigint, liveness: bigint, atBlock: bigint): Hex =>
  `0x${pad32(identifier)}${word(160n)}${word(bond)}${word(liveness)}${word(atBlock)}${bytesTail(claim)}` as Hex;

const outcomeData = (atBlock: bigint): Hex => `0x${word(atBlock)}` as Hex;

/** The id the contract would have derived for the default fixture. */
const DEFAULT_ID = computeAssertionId(IDENTIFIER, CLAIM, 10n, 1440n, BigInt(BLOCK));

const mkLog = (over: Partial<RpcLog> = {}): RpcLog => ({
  address: CORE,
  topics: [MUO_TOPIC0.Asserted, topicOf(DEFAULT_ID), addrTopic(ACTOR)],
  data: assertedData(IDENTIFIER, CLAIM, 10n, 1440n, BigInt(BLOCK)),
  blockNumber: BigInt(BLOCK),
  blockHash: BLOCK_HASH,
  transactionHash: TX_HASH,
  transactionIndex: 3,
  logIndex: 7,
  removed: false,
  ...over,
});

describe("topic table", () => {
  test("every frozen topic0 equals keccak256 of its human signature", () => {
    for (const name of MUO_EVENT_NAMES) {
      const derived: string = `0x${bytesToHex(keccak_256(new TextEncoder().encode(MUO_EVENT_SIGNATURES[name])))}`;
      expect<string>(MUO_TOPIC0[name]).toBe(derived);
    }
  });

  test("topics are derived from the compiler ABI, not a hand-written table", () => {
    // If @muo/core/abi changes an event signature, this fails rather than
    // silently decoding against a stale selector.
    const asserted = getAbiItem({ abi: muoCoreAbi, name: "Asserted" });
    expect(MUO_TOPIC0.Asserted).toBe(toEventSelector(asserted));
    for (const name of MUO_EVENT_NAMES) {
      expect(MUO_TOPIC0[name]).toBe(toEventSelector(getAbiItem({ abi: muoCoreAbi, name })));
    }
  });

  test("viem accepts trailing bytes but the decoder rejects them", () => {
    // Guard for the specific hole: decodeEventLog ignores bytes appended after a
    // fully decoded payload, so an exact-length check is mandatory.
    const base = assertedData(IDENTIFIER, CLAIM, 10n, 1440n, BigInt(BLOCK));
    const withJunk = `${base}${"00".repeat(32)}` as Hex;
    const topics = [MUO_TOPIC0.Asserted, topicOf(DEFAULT_ID), addrTopic(ACTOR)] as [Hex, ...Hex[]];

    // viem alone says "fine".
    const viemOk = decodeEventLog({ abi: muoCoreAbi, data: withJunk, topics, strict: true });
    expect(viemOk.eventName).toBe("Asserted");

    // The decoder does not.
    expect(() => decodeMuoLog(mkLog({ data: withJunk }), CHAIN, CORE)).toThrow(MuoLogDecodeError);
  });

  test("the documented golden digest is unchanged by the native decoder path", () => {
    // Same vector as packages/utils/src/__tests__/native.test.ts.
    expect(computeAssertionId(`0x${"bb".repeat(32)}`, `0x${"cc".repeat(64)}`, 10_000n, 1440n, 900_000n)).toBe(
      "0xc7ad84cdbc859160151cf23a7cfe5aaf67115a58447971c926292aab113741b5"
    );
  });

  test("the decoder does not require identifier == sha256(claim)", () => {
    // The contract accepts any bytes32 identifier; another client may use a
    // different convention. The decoder must accept it as long as the id
    // matches the recomputed preimage.
    const oddIdentifier = `0x${"00".repeat(32)}` as Hex;
    const id = computeAssertionId(oddIdentifier, CLAIM, 10n, 1440n, BigInt(BLOCK));
    const ev = decodeMuoLog(
      mkLog({ topics: [MUO_TOPIC0.Asserted, topicOf(id), addrTopic(ACTOR)], data: assertedData(oddIdentifier, CLAIM, 10n, 1440n, BigInt(BLOCK)) }),
      CHAIN,
      CORE
    );
    expect((ev as { data: { identifier: string } }).data.identifier).toBe(oddIdentifier);
  });

  test("the five topics are distinct and all recognised", () => {
    const values = MUO_EVENT_NAMES.map((n) => MUO_TOPIC0[n]);
    expect(new Set(values).size).toBe(5);
    for (const v of values) expect(isMuoTopic(v)).toBe(true);
    expect(isMuoTopic(`0x${"00".repeat(32)}`)).toBe(false);
    expect(isMuoTopic(undefined)).toBe(false);
  });
});

describe("decodeMuoLog — in scope", () => {
  test("Asserted decodes to the native envelope with a recomputed id", () => {
    const ev = decodeMuoLog(mkLog(), CHAIN, CORE);
    expect(ev).not.toBeNull();
    expect(isAssertionEvent(ev)).toBe(true);
    expect(ev).toEqual({
      event: "asserted",
      data: {
        assertionId: DEFAULT_ID,
        identifier: IDENTIFIER,
        claim: CLAIM,
        bondMusd: "10",
        liveness: 1440,
        assertedBy: ACTOR,
        assertedAtBlock: BLOCK,
        assertedTxId: TX_HASH,
      },
      provenance: {
        chainId: CHAIN,
        coreAddress: CORE,
        blockNumber: BLOCK,
        blockHash: BLOCK_HASH,
        transactionHash: TX_HASH,
        transactionIndex: 3,
        logIndex: 7,
      },
    });
  });

  test("bondMusd is a decimal STRING, never a number", () => {
    const ev = decodeMuoLog(mkLog(), CHAIN, CORE);
    expect(typeof (ev as { data: { bondMusd: unknown } }).data.bondMusd).toBe("string");
    expect((ev as { data: { bondMusd: string } }).data.bondMusd).toBe("10");
  });

  test("a bond far above 2^53 is preserved exactly as a string", () => {
    const bond = (1n << 100n) + 7n;
    const id = computeAssertionId(IDENTIFIER, CLAIM, bond, 1440n, BigInt(BLOCK));
    const ev = decodeMuoLog(
      mkLog({ topics: [MUO_TOPIC0.Asserted, topicOf(id), addrTopic(ACTOR)], data: assertedData(IDENTIFIER, CLAIM, bond, 1440n, BigInt(BLOCK)) }),
      CHAIN,
      CORE
    );
    const data = (ev as { data: { bondMusd: string; assertionId: string } }).data;
    expect(data.bondMusd).toBe(bond.toString());
    expect(BigInt(data.bondMusd)).toBe(bond);
    expect(data.assertionId).toBe(id);
    expect(isBondMusdWire(data.bondMusd)).toBe(true);
  });

  test("a 2048-byte claim round-trips byte-for-byte", () => {
    const claim = `0x${"ab".repeat(2048)}` as Hex;
    const id = computeAssertionId(IDENTIFIER, claim, 10n, 1440n, BigInt(BLOCK));
    const ev = decodeMuoLog(
      mkLog({ topics: [MUO_TOPIC0.Asserted, topicOf(id), addrTopic(ACTOR)], data: assertedData(IDENTIFIER, claim, 10n, 1440n, BigInt(BLOCK)) }),
      CHAIN,
      CORE
    );
    const data = (ev as { data: { claim: string; assertionId: string } }).data;
    expect(data.claim).toBe(claim);
    expect(data.claim.length).toBe(2 + 2048 * 2);
    expect(data.assertionId).toBe(id);
  });

  test("a 1-byte claim (minimum) decodes", () => {
    const claim = "0xff" as Hex;
    const id = computeAssertionId(IDENTIFIER, claim, 10n, 1n, BigInt(BLOCK));
    const ev = decodeMuoLog(
      mkLog({ topics: [MUO_TOPIC0.Asserted, topicOf(id), addrTopic(ACTOR)], data: assertedData(IDENTIFIER, claim, 10n, 1n, BigInt(BLOCK)) }),
      CHAIN,
      CORE
    );
    expect((ev as { data: { claim: string; assertionId: string } }).data).toMatchObject({ claim, assertionId: id });
  });

  test("arbitrary non-UTF-8 claim bytes are preserved", () => {
    const claim = "0x00fffe80c328" as Hex;
    const id = computeAssertionId(IDENTIFIER, claim, 10n, 1440n, BigInt(BLOCK));
    const ev = decodeMuoLog(
      mkLog({ topics: [MUO_TOPIC0.Asserted, topicOf(id), addrTopic(ACTOR)], data: assertedData(IDENTIFIER, claim, 10n, 1440n, BigInt(BLOCK)) }),
      CHAIN,
      CORE
    );
    expect((ev as { data: { claim: string; assertionId: string } }).data).toMatchObject({ claim, assertionId: id });
  });

  test.each([
    ["Disputed", MUO_TOPIC0.Disputed, "disputed", "disputedBy", "disputedAtBlock", "disputedTxId"],
    ["Settled", MUO_TOPIC0.Settled, "settled", "settledBy", "settledAtBlock", "settledTxId"],
    ["Rejected", MUO_TOPIC0.Rejected, "rejected", "rejectedBy", "rejectedAtBlock", "rejectedTxId"],
    ["Unresolved", MUO_TOPIC0.Unresolved, "unresolved", "unresolvedBy", "unresolvedAtBlock", "unresolvedTxId"],
  ] as const)("%s decodes with its own discriminant and actor", (_n, topic, kind, byKey, atKey, txKey) => {
    const ev = decodeMuoLog(mkLog({ topics: [topic, topicOf(DEFAULT_ID), addrTopic(OTHER_ACTOR)], data: outcomeData(BigInt(BLOCK)) }), CHAIN, CORE);
    expect(ev).not.toBeNull();
    expect(isAssertionEvent(ev)).toBe(true);
    const data = (ev as unknown as { event: string; data: Record<string, unknown> }).data;
    expect((ev as { event: string }).event).toBe(kind);
    expect(data.assertionId).toBe(DEFAULT_ID);
    expect(data[byKey]).toBe(OTHER_ACTOR);
    expect(data[atKey]).toBe(BLOCK);
    expect(data[txKey]).toBe(TX_HASH);
  });

  test("uppercase hex in topics and data normalizes to lowercase", () => {
    const ev = decodeMuoLog(
      mkLog({
        address: CORE.toUpperCase().replace("0X", "0x"),
        topics: [
          MUO_TOPIC0.Asserted.toUpperCase().replace("0X", "0x"),
          topicOf(DEFAULT_ID).toUpperCase().replace("0X", "0x"),
          addrTopic(ACTOR).toUpperCase().replace("0X", "0x"),
        ],
        data: assertedData(IDENTIFIER, CLAIM, 10n, 1440n, BigInt(BLOCK)).toUpperCase().replace("0X", "0x") as Hex,
      }),
      CHAIN,
      CORE
    );
    expect(ev).not.toBeNull();
    expect((ev as { data: { assertionId: string; assertedBy: string } }).data.assertionId).toBe(DEFAULT_ID);
    expect((ev as { data: { assertedBy: string } }).data.assertedBy).toBe(ACTOR);
  });

  test("string block numbers and indices are accepted", () => {
    const ev = decodeMuoLog(mkLog({ blockNumber: String(BLOCK), transactionIndex: "3", logIndex: "7" }), CHAIN, CORE);
    expect((ev as { provenance: { blockNumber: number } }).provenance.blockNumber).toBe(BLOCK);
  });
});

describe("decodeMuoLog — out of scope returns null", () => {
  test("a different contract address is skipped", () => {
    expect(decodeMuoLog(mkLog({ address: OTHER_ACTOR }), CHAIN, CORE)).toBeNull();
  });

  test("an unknown topics[0] is skipped", () => {
    expect(decodeMuoLog(mkLog({ topics: [`0x${"00".repeat(32)}`, topicOf(IDENTIFIER)] }), CHAIN, CORE)).toBeNull();
  });

  test("an empty topics array is skipped", () => {
    expect(decodeMuoLog(mkLog({ topics: [] }), CHAIN, CORE)).toBeNull();
  });

  test("ArbiterAdded is not a MuoCore assertion event and is skipped", () => {
    const arbiterAdded = `0x${bytesToHex(keccak_256(new TextEncoder().encode("ArbiterAdded(address)")))}`;
    expect(decodeMuoLog(mkLog({ topics: [arbiterAdded, addrTopic(ACTOR)], data: "0x" }), CHAIN, CORE)).toBeNull();
  });

  test("a removed log is skipped, not applied", () => {
    expect(decodeMuoLog(mkLog({ removed: true }), CHAIN, CORE)).toBeNull();
  });

  test("a non-object log is skipped", () => {
    for (const v of [null, undefined, 42, "log", []]) expect(decodeMuoLog(v, CHAIN, CORE)).toBeNull();
  });
});

describe("decodeMuoLog — in-scope malformed logs halt", () => {
  const throws = (log: RpcLog) => expect(() => decodeMuoLog(log, CHAIN, CORE)).toThrow(MuoLogDecodeError);

  test("a truncated Asserted payload throws", () => {
    throws(mkLog({ data: "0x" }));
  });

  test("an Asserted payload with a wrong claim offset throws", () => {
    const bad = `0x${pad32(IDENTIFIER)}${word(192n)}${word(10n)}${word(1440n)}${word(BigInt(BLOCK))}${bytesTail(CLAIM)}` as Hex;
    throws(mkLog({ data: bad }));
  });

  test("an Asserted payload whose id does not match the preimage throws", () => {
    const wrongId = `0x${"99".repeat(32)}`;
    throws(mkLog({ topics: [MUO_TOPIC0.Asserted, wrongId, addrTopic(ACTOR)] }));
  });

  test("an Asserted payload claiming a different block throws", () => {
    throws(mkLog({ data: assertedData(IDENTIFIER, CLAIM, 10n, 1440n, BigInt(BLOCK + 1)) }));
  });

  test("a zero-length claim throws", () => {
    const bad = `0x${pad32(IDENTIFIER)}${word(160n)}${word(10n)}${word(1440n)}${word(BigInt(BLOCK))}${word(0n)}` as Hex;
    throws(mkLog({ data: bad }));
  });

  test("a claim longer than 2048 bytes throws", () => {
    const claim = `0x${"ab".repeat(2049)}` as Hex;
    throws(mkLog({ data: assertedData(IDENTIFIER, claim, 10n, 1440n, BigInt(BLOCK)) }));
  });

  test("a bond below 10 whole MUSD throws", () => {
    throws(mkLog({ data: assertedData(IDENTIFIER, CLAIM, 9n, 1440n, BigInt(BLOCK)) }));
  });

  test("a bond above uint128 max throws", () => {
    throws(mkLog({ data: assertedData(IDENTIFIER, CLAIM, 1n << 128n, 1440n, BigInt(BLOCK)) }));
  });

  test("liveness 0 and 52561 throw", () => {
    throws(mkLog({ data: assertedData(IDENTIFIER, CLAIM, 10n, 0n, BigInt(BLOCK)) }));
    throws(mkLog({ data: assertedData(IDENTIFIER, CLAIM, 10n, 52_561n, BigInt(BLOCK)) }));
  });

  test("an outcome payload with a trailing extra word throws", () => {
    throws(mkLog({ topics: [MUO_TOPIC0.Settled, topicOf(DEFAULT_ID), addrTopic(ACTOR)], data: `0x${word(BigInt(BLOCK))}${word(1n)}` as Hex }));
  });

  test("an outcome payload claiming a different block throws", () => {
    throws(mkLog({ topics: [MUO_TOPIC0.Disputed, topicOf(DEFAULT_ID), addrTopic(ACTOR)], data: outcomeData(BigInt(BLOCK + 5)) }));
  });

  test("a topic count other than 3 throws", () => {
    throws(mkLog({ topics: [MUO_TOPIC0.Asserted, topicOf(IDENTIFIER)] }));
    throws(mkLog({ topics: [MUO_TOPIC0.Asserted, topicOf(IDENTIFIER), addrTopic(ACTOR), addrTopic(ACTOR)] }));
  });

  test("odd-length data hex throws", () => {
    throws(mkLog({ data: "0xabc" as Hex }));
  });

  test("a missing blockHash, transactionHash or transactionIndex throws", () => {
    throws(mkLog({ blockHash: null }));
    throws(mkLog({ transactionHash: null }));
    throws(mkLog({ transactionIndex: null }));
  });

  test("a blockNumber above the safe integer range throws", () => {
    throws(mkLog({ blockNumber: BigInt(Number.MAX_SAFE_INTEGER) + 1n }));
  });

  test("an id topic that is not 32 bytes throws", () => {
    throws(mkLog({ topics: [MUO_TOPIC0.Asserted, `0x${"11".repeat(31)}`, addrTopic(ACTOR)] }));
  });
});

describe("decodeMuoLog — argument guards", () => {
  test("an unsupported chain id throws", () => {
    expect(() => decodeMuoLog(mkLog(), 1 as never, CORE)).toThrow(TypeError);
  });

  test("a non-lowercase or malformed core address throws", () => {
    expect(() => decodeMuoLog(mkLog(), CHAIN, CORE.toUpperCase().replace("0X", "0x") as Address)).toThrow(TypeError);
    expect(() => decodeMuoLog(mkLog(), CHAIN, "0x123" as Address)).toThrow(TypeError);
  });
});
