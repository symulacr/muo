// Smoke check: boot the harness, confirm the portal HTML is served with the
// fake wallet injected, then tear everything down. No browser involved.
//
//   bun --no-env-file src/test-support/browser/smoke.ts
//
// Prints a single JSON line so the result is easy to read from a shell.
// NOTE: this runs a real production build, so it takes a couple of minutes.

import { startHarness } from "./harness";

const harness = await startHarness();
try {
  const res = await fetch(harness.proxyUrl, { signal: AbortSignal.timeout(20_000) });
  const html = await res.text();
  const injectedAt = html.indexOf("isFakeLocalWallet");
  const firstAppScript = html.indexOf("/_next/");
  const out = {
    ok: res.ok,
    status: res.status,
    htmlBytes: html.length,
    injected: injectedAt >= 0,
    injectedBeforeAppScript: injectedAt >= 0 && firstAppScript >= 0 && injectedAt < firstAppScript,
    coreAddress: harness.coreAddress,
    musdAddress: harness.musdAddress,
    proxyUrl: harness.proxyUrl,
    apiUrl: harness.apiUrl,
  };
  console.log(JSON.stringify(out));
} finally {
  await harness.stop();
}
