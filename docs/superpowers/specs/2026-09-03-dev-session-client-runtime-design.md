# Design — `@polyant-ai/plugin-sdk/dev`: the dev-session client runtime

- **Date:** 2026-09-03
- **Branch:** `feat/dev-session-runtime`
- **Reference spec (engine side, already shipped):** `polyant-enterprise` → `docs/dev-mode.md` and
  `docs/superpowers/specs/2026-09-01-dev-mode-remote-tool-bridge-design.md`
- **Version impact:** a NEW entry point, no change to `.` ⇒ **minor bump** `1.5.0` → `1.6.0`.
  Not bumped, tagged or published here: the release is coordinated separately.

## Problem

The engine's dev mode is complete: a developer opens a WebSocket to `/dev-mode/socket` with a
per-agent token, declares serialized tool definitions, and the engine equips them for a turn as
ordinary `ToolDefinition`s whose `execute` is an RPC proxy — ajv validation, governance, audit and
trace are the real ones. The engine's own doc said it plainly: *"the client side does not exist in
this repository yet"*. This delivery is that client.

It belongs here rather than in `polyant-cli` because what crosses the wire is this package's
contract: `ToolDefinition` on the way out, `ToolContext` on the way in. A CLI wrapping it needs no
knowledge of either.

## Approach

A second entry point, `./dev`, Node-only, with the package root untouched. Five modules:

| Module | Responsibility |
|---|---|
| `protocol.ts` | Verbatim port of the engine's `dev-protocol.ts` — same frames, same Zod schemas, same `DEV_PROTOCOL_VERSION` — relicensed Apache-2.0. Only the direction of the two helpers differs (`parseServerFrame` / `serializeClientFrame`). |
| `ctx-proxy.ts` | One invocation's `ToolContext`: snapshot-backed sync `state`, buffering `audit.log`, RPC-backed `conversation`/`oauth`, everything else inline. |
| `session.ts` | Connection, handshake, frame dispatch, reconnection, hot reload. |
| `load-tools.ts` | Filesystem discovery + import of `*.tool.*` default exports. |
| `websocket.ts` / `events.ts` | The injectable socket contract and the structured event union. |

## Public API

```ts
import { serveDevSession, loadToolsFromPaths } from "@polyant-ai/plugin-sdk/dev";

const tools = await loadToolsFromPaths(["./src/tools"], { cacheBust: false });
const session = await serveDevSession({
  agentSlug: "acme-bot",
  token: process.env.POLYANT_DEV_TOKEN!,
  url: "wss://engine.example.com",   // path filled in with /dev-mode/socket when absent
  tools,
  onEvent: (event) => { /* render it; the library never prints */ },
});
session.updateTools(await loadToolsFromPaths(["./src/tools"], { cacheBust: true })); // hot reload
session.close();
```

```ts
function serveDevSession(opts: ServeDevSessionOptions): Promise<DevSessionHandle>;

interface ServeDevSessionOptions {
  agentSlug: string;
  token: string;
  url?: string;                        // default DEFAULT_DEV_SOCKET_URL
  tools: readonly ToolDefinition[];
  webSocketImpl?: DevWebSocketFactory; // default: the global WebSocket (Node 22+)
  onEvent?: DevSessionEventHandler;
  reconnect?: false | DevReconnectOptions;   // default { initialDelayMs: 500, maxDelayMs: 15000, factor: 2 }
  staleAfterMs?: number;               // default 60000 (three missed engine pings)
  sdkVersion?: string;                 // tests only
}

interface DevSessionHandle {
  readonly sessionId: string;
  readonly agentSlug: string;
  readonly warnings: readonly string[];   // handshake lint from the engine
  readonly engineVersion: string;
  readonly connected: boolean;
  updateTools(tools: readonly ToolDefinition[]): void;
  close(reason?: string): void;
}

function loadToolsFromPaths(paths: readonly string[], opts?: LoadToolsOptions): Promise<ToolDefinition[]>;
function isToolDefinition(value: unknown): value is ToolDefinition;
function toDeclarations(tools: readonly ToolDefinition[]): DevToolDeclaration[];
function createCtxProxy(opts: { inline: InlineToolContext; rpc: CtxRpc }): CtxProxy;
function defaultWebSocketFactory(): DevWebSocketFactory;
// plus the ported protocol surface: DEV_PROTOCOL_VERSION, CTX_OPS, clientFrameSchema,
// serverFrameSchema, parseServerFrame, serializeClientFrame, SDK_VERSION,
// DEV_SOCKET_PATH, DEFAULT_DEV_SOCKET_URL and the frame types.
```

## Design decisions

- **`ctx.state` is synchronous, and that is the whole architecture.** Reads come from the snapshot
  in the `tool.invoke` frame (mirrored in a local `Map` so a `set` reads back), writes are recorded
  in order and returned *with* the result. The engine applies them only on success, so a dev tool
  keeps the same commit-on-success guarantee as a shipped one. `audit.log` is `void` and buffers the
  same way. Anything already async in-process (`conversation`, `oauth`) is a real RPC.
- **The recorded buffers are handed out as copies.** A caller cannot mutate what is about to be
  sent; asserted by a test.
- **Frames are validated with the engine's own schemas in the tests, not at runtime.** Sending is a
  plain `JSON.stringify` of a typed frame — the cheap proof that this client speaks the server's
  protocol is `clientFrameSchema.parse` over every frame the fake socket received, and the fake
  engine's frames go through `serverFrameSchema` for the same reason in reverse.
- **A refused handshake is never retried.** `hello.error` (bad token, unknown agent, protocol
  mismatch) stops the runtime for good: retrying cannot make a rejected token valid. A *dropped*
  connection is retried with exponential backoff, so an engine restart is survivable without the
  wrapper re-running anything.
- **The first connection's failure is the caller's failure.** `serveDevSession` rejects instead of
  retrying in the background — a CLI must be able to say "wrong token" and exit non-zero. Failures
  after that arrive as events.
- **A stale-connection watchdog, not just `close`.** A TCP connection dropped without a FIN emits no
  `close` event, so the session would sit believing it is connected. Any frame rearms a 60s timer
  (the engine pings every 20s); on expiry the socket is closed, which routes into the single
  reconnection path.
- **An aborted call's result is discarded, never sent.** The engine has already settled it, so a
  late `tool.result` would apply state writes to a turn that no longer exists. Its outstanding ctx
  RPCs are rejected so the local `execute` unwinds.
- **`overrides` always goes on the wire as `null`.** The engine decides substitution by name
  collision and treats the field as diagnostics only; a non-null value could produce nothing but a
  handshake warning telling you to rename the tool. Rename the tool.
- **Node's global `WebSocket` is the default, `webSocketImpl` the seam.** It keeps the promise that
  this package acquires no new runtime dependency, and injection is what makes the runtime testable
  with no network and usable on Node 20/21 (pass `(url) => new WS(url)` from `ws`). The socket
  contract is typed as the WHATWG `addEventListener` shape, which both the global and `ws` satisfy.
- **`engines` stays `>=20`.** The root entry — the authoring contract, which is what almost every
  consumer imports — has no WebSocket requirement, and raising the floor for a second entry point
  would deny it to consumers that never touch dev mode. The default factory therefore fails with an
  explicit message naming `webSocketImpl`, instead of `WebSocket is not a constructor`. The cost is
  declared, not hidden: **the default transport needs Node 22+; on Node 20/21 inject one.**
- **`SDK_VERSION` is a literal, guarded by a test.** The handshake reports it, and this entry must
  stay importable from `dist/` with no filesystem read or JSON import assertion. The test fails when
  it drifts from `package.json`.
- **No `console.*`, ever.** Everything the runtime would have logged is a `DevSessionEvent`
  (`connecting`, `connected`, `handshake_rejected`, `invoke`, `result`, `aborted`, `ctx_request`,
  `tools_updated`, `disconnected`, `error`, `closed`). A throwing handler cannot take the session
  down.
- **Loading TypeScript is the caller's problem.** `loadToolsFromPaths` does a plain dynamic
  `import()`; a `*.tool.ts` path only resolves if the *host process* was started with `tsx` or an
  equivalent loader. Registering a loader is a decision about the whole process and belongs to
  whoever owns the entry point. `cacheBust` is opt-in because Node's ESM cache has no invalidation
  and the query-string trick leaks a registry entry per reload — but without it a "hot reload"
  silently serves the original module, which is worse than none.
- **A duplicate tool name fails before a socket is opened.** The engine rejects the whole handshake
  on a duplicate; failing locally names the offending tool.

## Testing

34 tests over five files, all driving the runtime through an injected in-memory socket
(`fake-socket.test-fixture.ts`, excluded from the build):

- `session.test.ts` (13) — handshake frame shape, `hello.error` with no retry, duplicate names,
  invocation with state/audit write-back, a thrown tool error as a result with **no** writes, an
  unserved tool name, ctx RPC correlated to the in-flight `callId` (and a failed one surfacing as a
  rejection), abort discarding the result and rejecting pending RPCs, `ping`→`pong`, reconnection
  re-declaring the current set, `reconnect: false`, idempotent `close`, and `tools.update` hot
  reload serving the new implementation.
- `protocol.test.ts` (7) — the version constant, the ctx-op list, Zod defaults, the 64KB
  `inputSchema` cap, round-trips, and that `parseServerFrame` never throws.
- `ctx-proxy.test.ts` (7) — synchronous reads/writes, ordering, buffer copies, inline fields, the
  three RPC ops with their arguments, and `Buffer` revival on attachments.
- `load-tools.test.ts` (5) + `sdk-version.test.ts` (2).

## Out of scope / left uncovered

- **A local tool cannot observe an abort.** `ToolDefinition.execute(input, ctx)` takes no
  `AbortSignal` — the authoring contract has no place to put one — so an abort stops the *result*
  from being sent but the local function keeps running to completion. Fixing it means adding a
  signal to the public `execute` signature: a contract change, deliberately not made here.
- **No client-side call timeout.** The engine already bounds an invocation
  (`DEV_MODE_CALL_TIMEOUT_MS`, 30s) and reports the timeout to the model; a second, disagreeing
  budget on this side would only produce two stories about the same call.
- **No attachment re-fetch.** The engine omits attachments over 256KB by design; this client has no
  endpoint to ask for them and does not pretend to.
- **`memoryScopeKey` is typed on `DevToolContext`, not on the public `ToolContext`.** It travels
  inline because the engine puts it there, but it is not part of the authoring contract and a dev
  tool should not start depending on it.
- **Not published.** No version bump, no tag: the release is coordinated by the repo owner.
- **`polyant dev --agent <slug>`** — the CLI wrapper is a separate deliverable in `polyant-cli`.
