import { expect, test } from "bun:test";
import { is, SQL } from "drizzle-orm";
import { Subquery, WithSubquery } from "drizzle-orm/subquery";
import { TrieRouter } from "hono/router/trie-router";

test("subquery stubs preserve constructor metadata and Drizzle entity identity", async () => {
  const stub = await import("../../stub-locales.js" as string);
  const args: ConstructorParameters<typeof Subquery> = [new SQL([]), {}, "inner", true, ["assertions"]];
  for (const actual of [Subquery, WithSubquery]) {
    const replacement = new stub[actual.name](...args);
    expect(replacement._).toEqual(new actual(...args)._);
    expect(is(replacement, actual)).toBe(true);
    expect(is(replacement, Subquery)).toBe(true);
  }
});

test("subquery stub supports Drizzle's prototype extension during module startup", async () => {
  const { Subquery: Stub, WithSubquery: WithStub } = await import("../../stub-locales.js" as string);
  const original = Object.getOwnPropertyDescriptor(Stub.prototype, "getSQL");
  const getSQL = () => new SQL([]);
  try {
    expect(Reflect.set(Stub.prototype, "getSQL", getSQL)).toBe(true);
    expect(new Stub().getSQL()).toBeInstanceOf(SQL);
    expect(new WithStub().getSQL()).toBeInstanceOf(SQL);
  } finally {
    if (original) Object.defineProperty(Stub.prototype, "getSQL", original);
    else if (Stub.prototype) Reflect.deleteProperty(Stub.prototype, "getSQL");
  }
});

test("router stub uses Hono's constructible TrieRouter and matches registered routes", async () => {
  const stub = await import("../../stub-locales.js" as string);
  const router = new stub.TrieRouter();
  const handler = () => new Response("ok");
  router.add("GET", "/health", handler);
  expect(router).toBeInstanceOf(TrieRouter);
  expect(router.match("GET", "/health")[0][0][0]).toBe(handler);
});
