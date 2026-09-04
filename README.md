# @polyant-ai/plugin-sdk

The stable, public contract for authoring **Polyant engine plugins** — the tools
an AI agent can call. A plugin repo depends on this package and nothing else of
the engine's internals.

It is deliberately **tiny and stateless**: it exposes `defineTool` + the types a
tool needs. It does **not** own the tool registry — the engine's loader does — so
your plugin can carry its own copy of this SDK (and its own `zod`, `ai`, …)
without any shared-singleton coupling. This is what lets a plugin live in its own
repo, resolve its own dependencies, and be built/bundled independently.

## Install

```bash
# public git repo — reference by tag (no auth needed)
npm i -D git+https://github.com/polyant-ai/polyant-sdk.git#v1.4.0
npm i zod              # peer dependency (you author schemas in zod)
```

Your plugin's `package.json`:

```jsonc
{
  "peerDependencies": { "@polyant-ai/plugin-sdk": "*" },
  "devDependencies":  { "@polyant-ai/plugin-sdk": "git+https://github.com/polyant-ai/polyant-sdk.git#v1.4.0" },
  "dependencies":     { "zod": "^3.23.0" /* + any lib your tools call */ }
}
```

## Authoring a tool

A tool file is `tools/<name>.tool.ts` and **default-exports** a `defineTool(...)`:

```ts
import { defineTool } from "@polyant-ai/plugin-sdk";
import { z } from "zod";

export default defineTool({
  name: "bookAppointment",              // becomes "<namespace>:bookAppointment"
  description: "Book an appointment in the CRM.",
  category: "plugin",
  requiredSecrets: [{ key: "crm_api_key", type: "text" }],
  parameters: z.object({                // STATIC schema (must not depend on ctx)
    patientId: z.string(),
    date: z.string().describe("ISO 8601"),
  }),
  execute: async (input, ctx) => {      // ctx: agentId, secrets, audit, state, apiKeys…
    const key = ctx.secrets?.crm_api_key;
    // ... call your API, use ctx.audit / ctx.state ...
    return { status: "booked", id: "..." };
  },
});
```

### The contract in one paragraph

`defineTool` serializes your **static** `parameters` (a zod schema) to **JSON
Schema at module load, in your plugin's realm**. The engine only ever receives
data (`inputSchema`) plus your `execute` function — never a live zod object. That
data boundary is why multiple copies of this SDK / zod across plugins are
harmless. `execute(input, ctx)` runs your logic; do runtime/semantic validation
inside it and return `{ error: "..." }` rather than throwing.

### Rules for `parameters` (OpenAI strict-mode compatible)

- Use `.nullable()`, **not** `.optional()` / `.default()` (apply defaults in `execute`).
- No `.transform()` / `.refine()` / `.preprocess()` in the schema — move that logic to `execute`.
- Avoid `.url()`/`.email()`/`.uuid()`/`.datetime()` formats — validate strings in `execute`.
- `z.record(z.string(), z.string())` is fine; `z.record(z.unknown())` is not.

## Authoring a hook

A hook file is `hooks/<name>.hook.ts` and **default-exports** a `defineHook(...)`.
Unlike a tool, a hook is **deterministic lifecycle code** — never LLM-invoked,
never in the tool catalog. It runs at one of four conversation events
(`conversation_start`, `message_received`, `response_generated`, `response_sent`)
and may return a typed control object to influence the turn.

```ts
import { defineHook } from "@polyant-ai/plugin-sdk";

export default defineHook({
  name: "dirty-output-guard",
  description: "Replay the turn when the model emits corrupted output.",
  mutatesResponse: true,                 // required to return replaceResponse / regenerate
  handler: (ctx) => {
    const { text, regenerationCount } = ctx.payload.response!;   // response_generated only
    if (!isDirty(text)) return;                                  // void = observe only
    return regenerationCount < 2
      ? { regenerate: { reason: "corrupted output" } }           // re-run the whole turn
      : { replaceResponse: { message: "Sorry, please try again." } };
  },
});
```

### `HookResult` — how a hook influences a turn

| Return | Event | Effect |
|--------|-------|--------|
| `void` | any | observe only (default) |
| `{ halt: { message, persist? } }` | pre-LLM (`conversation_start`, `message_received`) | skip the LLM, reply with `message`. `persist: false` (since v1.5.0) also makes the turn ephemeral — no message rows, trace, state flush or summary/memory work — for command-style hooks whose exchange must stay out of the model's history |
| `{ injectContext: string }` | pre-LLM | append a one-shot system message to the turn's LLM input |
| `{ replaceResponse: { message } }` | `response_generated` | replace the LLM reply with `message` |
| `{ regenerate: { reason? } }` | `response_generated` | **discard the output and REPLAY the whole turn** (system prompt + tools) — since v1.4.0 |

`replaceResponse` and `regenerate` require the hook to declare
`mutatesResponse: true` (the engine then serves that turn non-streamed so the
mutation lands in time). For `regenerate`, the hook owns the stop condition via
`ctx.payload.response.regenerationCount` (`0` on the first pass); the engine
enforces a hard safety cap. If a pass returns both, `regenerate` wins.
**Caveat:** replay re-executes the whole turn, **tools included** — enable a
`regenerate` hook only where the turn is side-effect-free or its tools are
idempotent, and note that deterministic (`temperature: 0`) turns reproduce the
same output and merely exhaust the cap (it suits sporadic output corruption, not
systematic errors).

## `plugin.json` (at your repo root)

```json
{
  "name": "innovasemplice",
  "version": "1.0.0",
  "engine": ">=0.1.0",
  "toolsDir": "tools",
  "namespace": "innova"
}
```

| Field | Meaning |
|-------|---------|
| `name` | Stable plugin id (also the install dir name under the engine). |
| `version` | Your plugin's version (independent of the engine). |
| `engine` | Semver range of engine versions you support; mismatch → the engine skips your plugin with a warning. |
| `toolsDir` | Dir scanned for `*.tool.ts` (default `tools`). |
| `namespace` | Prefix applied to every tool name (`<namespace>:<name>`). Defaults to `name`. |

## API surface

- `defineTool(spec) => ToolDefinition` — the tool authoring entry point.
- `defineHook(spec) => HookFunctionDefinition` — the hook authoring entry point (deterministic lifecycle code, never LLM-invoked).
- `toJsonSchema(zodSchema)` — the zod→JSON-Schema conversion `defineTool` uses.
- `normalizeRequiredSecrets`, `requiredSecretKeys` — helpers for the secrets contract.
- Tool types: `ToolSpec`, `ToolDefinition`, `ToolInfo`, `ToolInputExample`, `RequiredSecretSpec`, `RequiredSecretsInput`.
- Context types: `ToolContext`, `AgentSlug`, `AuditLogger`, `Attachment`, `ChannelStateIdentity`, `ConversationStateApi`, `ConversationHistoryApi`, `ConversationMessage`, `ConversationRole`, `RecentMessagesOptions`, `ToolApiKeys`.
- Hook types: `HookSpec`, `HookFunctionDefinition`, `HookContext`, `HookResult`, `HookEvent`, `HookEventPayload`, `HookAi`.
- `@polyant-ai/plugin-sdk/dev` (separate entry point): `serveDevSession`, `loadToolsFromPaths`, `isToolDefinition`, `toDeclarations`, `createCtxProxy`, `defaultWebSocketFactory`, the ported wire protocol (`DEV_PROTOCOL_VERSION`, `clientFrameSchema`, `serverFrameSchema`, `parseServerFrame`, `serializeClientFrame`, `CTX_OPS`) and its types. See **Dev mode** above.

## Dev mode: run a local tool inside a remote agent

`@polyant-ai/plugin-sdk/dev` is a **separate, Node-only entry point** (nothing in it is
pulled in by the root import). It connects your local `*.tool.ts` files to a remote
Polyant agent over the engine's dev bridge: the agent equips them for a turn and calls
their real `execute` with the real `ToolContext` — scoped secrets, conversation state,
audit, OAuth, history. Your code never leaves your machine.

Issue a per-agent token from the agent's **Dev** tab in the admin panel, then:

```ts
import { serveDevSession, loadToolsFromPaths } from "@polyant-ai/plugin-sdk/dev";

const tools = await loadToolsFromPaths(["./src/tools"]);
const session = await serveDevSession({
  agentSlug: "acme-bot",
  token: process.env.POLYANT_DEV_TOKEN!,
  url: "wss://engine.example.com",  // /dev-mode/socket is appended when the path is empty
  tools,
  onEvent: (event) => console.log(event),   // the library never prints on its own
});
// later, on a file change:
session.updateTools(await loadToolsFromPaths(["./src/tools"], { cacheBust: true }));
// session.close();
```

Three things to know before using it:

- **Run the process with `tsx`** (or another TypeScript loader) if your tool files are
  `.ts`. `loadToolsFromPaths` only does a dynamic `import()`; registering a loader is a
  decision about the whole process, so it is the caller's, not this package's.
- **The default transport is Node's global `WebSocket`, which needs Node 22+** — this
  package takes no new runtime dependency for it. On Node 20/21, inject one:
  `webSocketImpl: (url) => new WS(url)` with `ws`. The same seam is how you test a
  session with no network.
- **A pending reconnection keeps your process alive.** The session is alive until you close
  it, so after a dropped connection the runtime holds the event loop while it retries —
  `session.close()` is what lets the process end, and `reconnect: false` arms no retry at
  all.
- `ctx.state` is **synchronous**, exactly as in-process: reads are served from the
  snapshot that came with the invocation, and your writes are returned with the result so
  the engine applies them only when the call succeeds.

Design record: [`docs/superpowers/specs/2026-09-03-dev-session-client-runtime-design.md`](docs/superpowers/specs/2026-09-03-dev-session-client-runtime-design.md).
The engine-side documentation is `docs/dev-mode.md` in `polyant-enterprise`.

## Versioning

This package's version **is** the plugin compatibility contract. It is referenced
by `plugin.json.engine` (via the engine version) and consumed by both the engine
and every plugin. Bump deliberately (semver); breaking the tool contract is a
major bump.

### 1.6.0 — agent terminology

Polyant renamed its core domain entity from *instance* to *agent*, so the contract
follows. The rename is **additive** — nothing you already shipped breaks:

| Before | Now | Old name |
|---|---|---|
| `InstanceSlug` | `AgentSlug` | deprecated alias, identical type |
| `ctx.instanceId` | `ctx.agentId` | deprecated, engine sets both |
| `payload.instance` / `ctx.instance` (hooks) | `payload.agent` / `ctx.agent` | deprecated, engine sets both |

A tool or hook built against ≤ 1.5.0 keeps compiling and keeps reading its old
field. The brand payload literal is intentionally unchanged, which is what makes
`AgentSlug` and `InstanceSlug` the same type in both directions. The deprecated
names are removed in the next major — migrate at your convenience. If you build a
`ToolContext` by hand (usually in tests), add `agentId` next to `instanceId`.

## License

[Apache License 2.0](LICENSE). This SDK is intentionally permissive so plugin
authors can build and ship tools under whatever license they choose — the
engine that consumes it is licensed separately.
