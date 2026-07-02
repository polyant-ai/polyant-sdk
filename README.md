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
npm i -D git+https://github.com/polyant-ai/polyant-sdk.git#v1.0.0
npm i zod              # peer dependency (you author schemas in zod)
```

Your plugin's `package.json`:

```jsonc
{
  "peerDependencies": { "@polyant-ai/plugin-sdk": "*" },
  "devDependencies":  { "@polyant-ai/plugin-sdk": "git+https://github.com/polyant-ai/polyant-sdk.git#v1.0.0" },
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
  execute: async (input, ctx) => {      // ctx: instanceId, secrets, audit, state, apiKeys…
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

- `defineTool(spec) => ToolDefinition` — the authoring entry point.
- `toJsonSchema(zodSchema)` — the zod→JSON-Schema conversion `defineTool` uses.
- `normalizeRequiredSecrets`, `requiredSecretKeys` — helpers for the secrets contract.
- Types: `ToolSpec`, `ToolDefinition`, `ToolContext`, `RequiredSecretSpec`, `ToolInfo`, `InstanceSlug`, `AuditLogger`, `Attachment`, `ConversationStateApi`, `ToolApiKeys`.

## Versioning

This package's version **is** the plugin compatibility contract. It is referenced
by `plugin.json.engine` (via the engine version) and consumed by both the engine
and every plugin. Bump deliberately (semver); breaking the tool contract is a
major bump.

## License

[Apache License 2.0](LICENSE). This SDK is intentionally permissive so plugin
authors can build and ship tools under whatever license they choose — the
engine that consumes it is licensed separately.
