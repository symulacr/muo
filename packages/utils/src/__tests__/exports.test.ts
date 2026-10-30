import { expect, test } from "bun:test";

import { computeAssertionId, ERR_TRANSFER_FAILED, STATUS_DISPUTED, STATUS_SETTLED } from "../index";
import { computeAssertionId as nativeId } from "../native";

test("default utility exports are native, not Clarity values", () => {
  expect(computeAssertionId).toBe(nativeId);
  expect(ERR_TRANSFER_FAILED).toBe(8400004n);
  expect(STATUS_DISPUTED).toBe(1);
  expect(STATUS_SETTLED).toBe(2);
});
