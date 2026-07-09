# @polyant-ai/plugin-sdk

Guide for people working **inside** this repo (developers + AI agents). For authoring a tool/plugin see the **[README.md](README.md)**.

## What it is

The **public, STATELESS contract** for Polyant plugin authors. It exposes `defineTool` + `defineHook` + the types a tool or hook consumes (`ToolSpec`, `ToolDefinition`, `ToolContext`, `RequiredSecretSpec`, `ToolInfo`, `InstanceSlug`, `AuditLogger`, `Attachment`, `ConversationStateApi`, `ConversationHistoryApi`, `ToolApiKeys`, `HookSpec`, `HookContext`, `HookResult`, …).

This package does **NOT own the tool registry** — that belongs to the engine loader (`polyant-enterprise`). As a result, having **multiple copies of the SDK around is harmless**: each plugin resolves its own copy (and its own `zod`, `ai`, …) with no shared-singleton coupling.

## Data-boundary principle (the cardinal rule)

`defineTool` serializes the `zod` schema (`parameters`) → JSON Schema **at module load, INSIDE the plugin's realm** (`toJsonSchema` in `src/contract.ts`). The engine receives **only data** (`inputSchema`, a plain object) plus the `execute` function.

- A **live** zod object **must NEVER cross the** engine↔plugin **boundary**.
- **Never** do a cross-package `instanceof` (it would fail: different classes from different copies of the SDK/zod).
- The types in `context-types.ts` are **structural** interfaces that mirror the engine's concrete shapes (`AuditLogger`, `Attachment`, `ConversationStateApi`, `ToolApiKeys`): the `InstanceSlug` brand is type-level only (phantom field), so the engine's concrete objects satisfy the contract **without importing the internals**.

## Ironclad rules

1. **Zero imports from the engine internals.** The SDK is self-contained; shared types are re-declared structurally in `context-types.ts`.
2. **Must stay stateless.** No `Map`/registries/singletons/module state. Only pure functions + types.
3. **Must ship built.** `main: dist/index.js`, `types: dist/index.d.ts`. The `prepare` script builds `dist` so the package is consumable as a **git-dependency** (npm runs `prepare` when cloning the git ref).
4. **`Buffer` requires `@types/node`** (used in `Attachment.data`) — already in `devDependencies`.

## How it is consumed

Both the engine (`polyant-enterprise`) and the plugins reference it as a **git-dependency** with a tag:

```
git+https://github.com/polyant-ai/polyant-sdk.git#<tag>
```
(public repo → https clone without auth; no SSH keys needed)

Each one resolves its **own** copy (see the data-boundary principle above). `zod` is a **peer dependency** — provided by the consumer.

## Versioning

The **SDK version IS the compatibility contract.** It binds to `plugin.json.engine` (semver range of supported engine versions) through the engine version.

- **Deliberate** semver bumps.
- **Breaking the tool contract = major bump.**
- Publishing a new version:
  1. bump `version` in `package.json`
  2. commit
  3. tag `vX.Y.Z`
  4. push the tag
  5. consumers update the git ref (`#vX.Y.Z`)

## Commands

```bash
npm run build       # tsc → dist/ (tsconfig.build.json)
npm run typecheck   # tsc --noEmit
npm test            # vitest (17 tests: contract 7, context-types 6, hooks 4)
```

## How to add/change the contract

1. Edit `src/contract.ts`, `src/context-types.ts`, or `src/hooks.ts` (and re-export from `src/index.ts` if needed).
2. Update/add the tests.
3. `npm test` + `npm run build`.
4. Bump version + tag (see Versioning) — an incompatible change is a major.
