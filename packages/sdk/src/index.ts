// `@muo/sdk` — native MuoCore log decoding.
//
// The default export is the native decoder. The legacy Clarity decoder and its
// Stacks transport have been removed: the portal, the API and the listener are
// all native now, so keeping a second event representation would only invite
// drift.
//
// `@muo/sdk/native` remains a valid subpath for explicit imports.

export * from "./native";
