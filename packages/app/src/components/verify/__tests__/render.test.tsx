import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AssertionDetail, LiveNode, NodeTrack, stageOf } from "@/components/verify/assertion-detail";
import { StatusBadge } from "@/components/verify/status-badge";
import { AddressBadge, identicon, seed } from "@/components/wallet-button";
import { makeAssertion } from "@/test-support/fixtures";

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("status badge", () => {
  test("renders a label for every status", () => {
    for (const status of ["open", "disputed", "settled", "rejected", "unresolved", "awaiting"] as const) {
      const html = render(createElement(StatusBadge, { status }));
      expect(html.length).toBeGreaterThan(0);
    }
  });

  test("keeps the 0..4 status meanings", () => {
    expect(render(createElement(StatusBadge, { status: "open" }))).toContain("Open");
    expect(render(createElement(StatusBadge, { status: "disputed" }))).toContain("Disputed");
    expect(render(createElement(StatusBadge, { status: "settled" }))).toContain("Settled");
    expect(render(createElement(StatusBadge, { status: "rejected" }))).toContain("Rejected");
    expect(render(createElement(StatusBadge, { status: "unresolved" }))).toContain("Unresolved");
  });
});

describe("stage derivation", () => {
  test("maps tx presence to the four stages", () => {
    expect(stageOf(makeAssertion({ settledTxId: null, resolvedTxId: null, disputedTxId: null }))).toBe(0);
    expect(stageOf(makeAssertion({ disputedTxId: `0x${"11".repeat(32)}` }))).toBe(1);
    expect(stageOf(makeAssertion({ disputedTxId: `0x${"11".repeat(32)}`, resolvedTxId: `0x${"22".repeat(32)}` }))).toBe(2);
    expect(stageOf(makeAssertion({ disputedTxId: `0x${"11".repeat(32)}`, resolvedTxId: `0x${"22".repeat(32)}`, settledTxId: `0x${"33".repeat(32)}` }))).toBe(3);
  });
});

describe("live indicator", () => {
  test("shows the block height when live", () => {
    expect(render(createElement(LiveNode, { connected: true, block: 123 }))).toContain("#123");
  });

  test("does not claim live when disconnected", () => {
    const html = render(createElement(LiveNode, { connected: false, block: 123 }));
    expect(html).toContain("not live");
  });

  test("shows a dash with no block", () => {
    expect(render(createElement(LiveNode, { connected: false, block: null }))).toContain("—");
  });
});

describe("assertion detail", () => {
  test("renders the whole-MUSD bond without scaling it", () => {
    const html = render(createElement(AssertionDetail, { assertion: makeAssertion({ bondMusd: "10" }), currentBlock: 105 }));
    expect(html).toContain("10 MUSD");
    expect(html).not.toContain("10,000 MUSD");
  });

  test("renders a large bond exactly", () => {
    const html = render(createElement(AssertionDetail, { assertion: makeAssertion({ bondMusd: "9007199254740993" }), currentBlock: 105 }));
    expect(html).toContain("9007199254740993");
  });

  test("renders the decoded claim text", () => {
    const html = render(createElement(AssertionDetail, { assertion: makeAssertion({ claim: "0x48656c6c6f" }), currentBlock: 105 }));
    expect(html).toContain("Hello");
  });

  test("escapes a claim that looks like markup", () => {
    const claimHex = `0x${Buffer.from("<img src=x onerror=alert(1)>").toString("hex")}`;
    const html = render(createElement(AssertionDetail, { assertion: makeAssertion({ claim: claimHex }), currentBlock: 105 }));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  test("does not throw on invalid UTF-8 claim bytes", () => {
    expect(() => render(createElement(AssertionDetail, { assertion: makeAssertion({ claim: "0xff" }), currentBlock: 105 }))).not.toThrow();
  });

  test("shows remaining blocks while the window is open", () => {
    const html = render(createElement(AssertionDetail, { assertion: makeAssertion({ assertedAtBlock: 100, liveness: 10 }), currentBlock: 105 }));
    expect(html).toContain("5 left");
  });

  test("shows ready once the window has closed", () => {
    const html = render(createElement(AssertionDetail, { assertion: makeAssertion({ assertedAtBlock: 100, liveness: 10 }), currentBlock: 111 }));
    expect(html).toContain("ready");
  });
});

describe("node track", () => {
  test("renders without a block height", () => {
    expect(() => render(createElement(NodeTrack, { assertion: makeAssertion(), currentBlock: null, detail: true }))).not.toThrow();
  });

  test("renders the compact variant", () => {
    expect(render(createElement(NodeTrack, { assertion: makeAssertion(), currentBlock: 105 }))).toContain("Stage");
  });
});

describe("address badge", () => {
  test("truncates the address and keeps the full value in the title", () => {
    const addr = "0x1111111111111111111111111111111111111111";
    const html = render(createElement(AddressBadge, { address: addr }));
    expect(html).toContain("0x1111...1111");
    expect(html).toContain(addr);
  });

  test("identicon is deterministic and seed-sensitive", () => {
    expect(identicon(seed("0xabc"))).toBe(identicon(seed("0xabc")));
    expect(seed("0xabc")).not.toBe(seed("0xdef"));
  });
});
