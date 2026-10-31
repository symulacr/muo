# Source artifact staging and release gates

`bun --no-env-file run stage:source` creates a local source directory and a SHA-256 manifest. It does **not** deploy, upload, commit, add files to Git or change a remote project.

This document covers how to produce a reviewable artifact and what must be approved before anything leaves the machine. For implementation status and current limits, see [MEZO-NATIVE-MIGRATION.md](MEZO-NATIVE-MIGRATION.md).

## Before running

1. Review the implementation and tests.
2. Review new source files and add only the intended paths to Git yourself. The script refuses eligible untracked source files rather than silently including them.
3. Stop concurrent edits while producing a release artifact.
4. Run the full local checks, then stage the exact source artifact.

The input is the **current working-tree content of Git-tracked files**, not necessarily the `HEAD` commit. The output manifest identifies the actual copied bytes. Do not describe a dirty working-tree export as a byte-for-byte export of a committed revision.

## Controls

- Explicit root/workspace path and file-type allowlist, preserving shared `theme/theme.css`.
- Real `.env*`, `.dev.vars`, private-key files, generated output and local tool directories are not copied.
- Tracked real environment/key material makes staging fail.
- File and directory symlinks are refused.
- Existing output directories and source-tree destinations are refused.
- A copied artifact starts as `scanState: "not-run"`.
- The CLI requires a successful fully redacted Gitleaks scan before returning `scanState: "clean"`.
- The scanner report and manifest live outside the source directory that would be deployed.

The scanner is discovered from `GITLEAKS_BIN`, then `~/.local/bin/gitleaks`, then `PATH`. Missing scanner, timeout or a finding fails the gate. An example environment file is intentionally public and must contain placeholders only.

## Commands

```bash
cd /home/eya/akindo/coo
node --test scripts/__tests__/stage-source.test.mjs
bun --no-env-file run verify:local
bun --no-env-file run stage:source
```

Inspect the returned manifest and exact source directory. Build that staged source with the required public configuration before requesting deployment approval. Do not recursively upload the developer's working directory.

## Local acceptance and release operator checklist

Run these locally before requesting any approval. They are read-only or local-build steps; none of them deploy.

**1. Local acceptance — one command**

```bash
bun --no-env-file install --ignore-scripts
bun --no-env-file run verify:local
```

`verify:local` runs the whole local gate serially: a frozen-install preflight, the workspace suites and Node guard tests, all nine TypeScript configs, Biome, the Workers runtime smoke test, both production builds one at a time, and `bun audit --json`. It checks the protected hashes and the generated-ABI shape before running anything.

Every step has a bounded timeout; a spawn error, signal, timeout or missing exit status is a failure, and the run stops at the first failing step with its name. There is no partial mode — a partial run is never a pass. `--list` prints the plan without executing it.

The gate has a **recorded pass**: 17/17 steps, exit 0, 674 aggregate checks, 0 failed, with nine TypeScript configs, Biome clean (174 files) and both builds passing. Evidence is in `outputs/continuation-20261028/verification/`. Re-run it on the exact tree being staged, since any change invalidates the record.

`packages/www` has no unit suite; it is covered by TypeScript, lint and its production build, all of which the gate includes.

**2. Stage the artifact**

```bash
bun --no-env-file run stage:source
```

Confirm `scanState: "clean"` and inspect the manifest. A clean scan is not proof that historical archives were clean.

**3. Stop and hand off**

Confirm no build servers, `next-server`, or `anvil` processes remain before handing off. Do not leave a background server running. The gate starts no servers and leaves none behind.

## Release gates (each requires separate explicit approval)

Local implementation being complete does not authorize a release.

| Gate | Requirement |
|---|---|
| Reviewed Git source | New source reviewed and added to Git by a human. Staging refuses eligible untracked source. |
| Redacted scanner artifact | Fresh, fully redacted Gitleaks CLI report accompanying the staged source. |
| Fresh public-environment build | Build staged source with real public configuration, not fixture values baked into a browser bundle. |
| D1 remote migration | Explicit approval to apply `0003` to the remote database. |
| API deploy | Explicit approval to deploy the Worker. |
| App and site deploy | Explicit approval to deploy each. |
| Public wallet transaction | Explicit approval for any public-chain transaction. |
| Cron enablement | Operator measurement of Workers CPU and backfill first. |

The contract, API Worker, portal and landing site are all deployed on Mezo Testnet. Any further deployment still requires explicit approval per action.

## Limits

Pattern scanning is not a guarantee that arbitrary secrets or personal content can never be present. A clean scan does not prove historical archives were clean, inaccessible or never read. Binary assets and intentionally public files still need human review.

No deployment, public transaction, credential rotation or historical archive cleanup is performed by this tool. Those require separate authorization. The historical Vercel secret archive question remains unresolved operator follow-up.
