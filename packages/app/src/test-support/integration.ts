// Single place where the app's tests reach the @muo/integration harness.
//
// The workspace devDependency `@muo/integration` is linked into node_modules, so
// this uses the package specifier rather than a relative path. Every test imports
// from here, so the harness entry point is swappable in one place.
//
// Read-only use: nothing here modifies the integration package.

export { MuoCoreClient, MusdClient, STATUS } from "@muo/integration/contracts";
export { deploy, loadArtifact, mockMusdArtifact, send } from "@muo/integration/deploy";
export { type Fixture, startAnvil } from "@muo/integration/fixture";
