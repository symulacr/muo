// `@muo/event-listener` — native Mezo sync controller.
//
// The default export is the native controller. The legacy Stacks WebSocket
// listener has been removed: the API no longer has a Stacks ingestion route to
// deliver to, so keeping it would be a dead path that could only confuse an
// operator into thinking it still worked.
//
// `@muo/event-listener/native` remains a valid subpath for explicit imports.

export * from "./native";
