import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

// These constructors are used during dependency initialization, even on write-only API routes.
export { Subquery, WithSubquery } from "drizzle-orm/subquery";
export { TrieRouter } from "hono/router/trie-router";

const f = () => ({ localeError: () => "invalid" });
const u = () => {
  throw new Error("Unimplemented crypto stub");
};
const C32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const sha = (b) => createHash("sha256").update(b).digest();
const ck = (x) => sha(sha(Buffer.from(x, "hex"))).subarray(0, 4);
export const [isPgEnum, bytesToHex] = [() => false, (b) => Buffer.from(b).toString("hex")];
export const [hexToBytes, sha256] = [(h) => new Uint8Array(Buffer.from(h, "hex")), (b) => new Uint8Array(sha(b))];
export const c32address = (v, h) => {
  if (!Number.isInteger(v) || v < 0 || v > 31 || !/^[0-9a-f]{40}$/i.test(h)) throw new Error("Invalid c32");
  const d = h.toLowerCase();
  const x = d + ck(v.toString(16).padStart(2, "0") + d).toString("hex");
  let [n, r] = [BigInt(`0x${x}`), ""];
  for (; n > 0n; n >>= 5n) r = C32[Number(n & 31n)] + r;
  return `S${C32[v]}${C32[0].repeat(Buffer.from(x, "hex").findIndex((b) => b))}${r}`;
};
export const addressToString = (a) => c32address(a.version, a.hash160);
export const deserializeAddress = (r) => ({ type: 0, version: r.readUInt8(), hash160: bytesToHex(r.readBytes(20)) });
export const deserializeLPString = (r, _p, m = 128) => {
  const l = r.readUInt8();
  if (l > m) throw new Error(`String length exceeds maximum bytes ${m}`);
  return { content: Buffer.from(r.readBytes(l)).toString("utf8") };
};
export const [createAddress, createLPString, createTableRelationsHelpers, extractTablesRelationalConfig, getCookie, getOperators] = [f, f, f, f, f, f];
export const [getOrderByOperators, getPublicKey, getSQLiteColumnBuilders, hmac, Many, normalizeRelation, One, Point, ripemd160] = [f, u, f, u, f, f, f, u, u];
export const [RelationalQueryBuilder, serializeAddressBytes, serializeLPStringBytes, Signature, SQLiteCountBuilder] = [f, f, f, u, f];
export const [SelectionProxyHandler, SQLiteRaw, SQLiteSelectBuilder, sha512_256, signSync, utils] = [f, f, f, u, u, f];
export const [c32addressDecode, verify] = [u, u];
export default f;
