import { expect, test } from "bun:test";

import { assertionSchema as assertionSubpath } from "../assertion";
import { assertionEventSchema as eventSubpath } from "../event";
import * as core from "../index";
import { assertionEventSchema, assertionSchema } from "../native";

test("all default and model subpath exports select the native schemas", () => {
  expect(core.assertionSchema).toBe(assertionSchema);
  expect(assertionSubpath).toBe(assertionSchema);
  expect(eventSubpath).toBe(assertionEventSchema);
  expect(core.MIN_BOND_MUSD).toBe(10n);
  expect(core.isBondMusdWire("10")).toBe(true);
  expect(core.isBondMusdWire(10)).toBe(false);
  expect(core.isAddress("SP000000000000000000002Q6VF78")).toBe(false);
  expect("MIN_BOND_SATS" in core).toBe(false);
  expect("isPrincipal" in core).toBe(false);
});
