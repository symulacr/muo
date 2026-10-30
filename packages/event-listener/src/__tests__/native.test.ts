import { describe, expect, test } from "bun:test";

import type { SyncConfig } from "../native";
import { DEFAULT_SYNC_CONFIG, readStatus, startSyncController, syncTick } from "../native";

const cfg = (over: Partial<SyncConfig> = {}): SyncConfig => ({
  apiUrl: "https://api.example",
  adminSecret: "admin-secret",
  ...DEFAULT_SYNC_CONFIG,
  ...over,
});

const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("syncTick", () => {
  test("posts to /v2/indexer/run with the admin bearer and no body", async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), init };
      return jsonRes({ status: "advanced", applied: 2, rebuilt: 1, reorg: false, to: { blockNumber: 500 } });
    }) as unknown as typeof fetch;
    const r = await syncTick(cfg(), { fetchImpl });
    expect(r).toEqual({ kind: "advanced", applied: 2, rebuilt: 1, reorg: false, blockNumber: 500 });
    expect(seen).toBeDefined();
    expect(seen?.url).toBe("https://api.example/v2/indexer/run");
    expect(seen?.init?.method).toBe("POST");
    const headers = (seen?.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer admin-secret");
    expect(seen?.init?.body).toBeUndefined();
  });

  test("strips a trailing slash from the base URL", async () => {
    let url = "";
    const fetchImpl = (async (u: string | URL | Request) => {
      url = String(u);
      return jsonRes({ status: "idle", reason: "caught-up" });
    }) as unknown as typeof fetch;
    await syncTick(cfg({ apiUrl: "https://api.example///" }), { fetchImpl });
    expect(url).toBe("https://api.example/v2/indexer/run");
  });

  test("maps an idle response", async () => {
    const fetchImpl = (async () => jsonRes({ status: "idle", reason: "lease-held" })) as unknown as typeof fetch;
    expect(await syncTick(cfg(), { fetchImpl })).toEqual({ kind: "idle", reason: "lease-held" });
  });

  test("maps a halted response", async () => {
    const fetchImpl = (async () => jsonRes({ status: "halted", reason: "decode", error: "bad log" })) as unknown as typeof fetch;
    expect(await syncTick(cfg(), { fetchImpl })).toEqual({ kind: "halted", reason: "decode", error: "bad log" });
  });

  test("treats a 401 as an http_error, not as success", async () => {
    const fetchImpl = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    const r = await syncTick(cfg(), { fetchImpl });
    expect(r.kind).toBe("http_error");
    if (r.kind === "http_error") expect(r.status).toBe(401);
  });

  test("treats an unexpected body as halted, never as advanced", async () => {
    const fetchImpl = (async () => jsonRes({ something: "else" })) as unknown as typeof fetch;
    const r = await syncTick(cfg(), { fetchImpl });
    expect(r.kind).toBe("halted");
  });
});

describe("readStatus", () => {
  test("reads /v2/status without a bearer and without triggering a run", async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const fetchImpl = (async (u: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(u), init };
      return jsonRes({ configured: true, state: "ok" });
    }) as unknown as typeof fetch;
    const s = await readStatus(cfg(), { fetchImpl });
    expect(s.state).toBe("ok");
    expect(seen?.url).toBe("https://api.example/v2/status");
    expect(seen?.init?.method).toBeUndefined();
  });

  test("throws on a non-200 so a caller cannot mistake it for health", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await expect(readStatus(cfg(), { fetchImpl })).rejects.toThrow("status HTTP 503");
  });
});

describe("startSyncController", () => {
  test("stops after a halted result instead of spinning", async () => {
    const lines: string[] = [];
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonRes({ status: "halted", reason: "decode", error: "bad" });
    }) as unknown as typeof fetch;
    const c = startSyncController(cfg(), {
      fetchImpl,
      sleepImpl: async () => undefined,
      log: (l) => lines.push(l),
      error: (l) => lines.push(l),
    });
    await c.run();
    expect(calls).toBe(1);
    expect(lines.join("\n")).toContain("halted");
  });

  test("gives up after the failure budget", async () => {
    let calls = 0;
    const c = startSyncController(cfg({ maxConsecutiveFailures: 3 }), {
      fetchImpl: (async () => {
        calls++;
        return new Response("boom", { status: 500 });
      }) as unknown as typeof fetch,
      sleepImpl: async () => undefined,
      log: () => undefined,
      error: () => undefined,
    });
    await c.run();
    expect(calls).toBe(3);
  });

  test("resets the failure counter after a success", async () => {
    let calls = 0;
    const c = startSyncController(cfg({ maxConsecutiveFailures: 2 }), {
      fetchImpl: (async () => {
        calls++;
        // fail(1) f=1, success(2) f=0, fail(3) f=1, fail(4) f=2 -> give up at 4.
        // Without the reset it would have given up at call 2.
        if (calls === 2) {
          return jsonRes({ status: "advanced", applied: 0, rebuilt: 0, reorg: false, to: { blockNumber: 1 } });
        }
        return new Response("boom", { status: 500 });
      }) as unknown as typeof fetch,
      sleepImpl: async () => undefined,
      log: () => undefined,
      error: () => undefined,
    });
    await c.run();
    expect(calls).toBe(4);
  });

  test("stop() ends the loop", async () => {
    let calls = 0;
    const c = startSyncController(cfg(), {
      fetchImpl: (async () => {
        calls++;
        return jsonRes({ status: "idle", reason: "caught-up" });
      }) as unknown as typeof fetch,
      sleepImpl: async () => {
        c.stop();
      },
      log: () => undefined,
      error: () => undefined,
    });
    await c.run();
    expect(calls).toBe(1);
  });
});
