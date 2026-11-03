# @polyant-ai/plugin-sdk

Guide for working **inside** this repo. For authoring a tool/plugin see the **[README.md](README.md)**.

## What it is

The **public, STATELESS contract** for Polyant plugin authors. It exposes `defineTool`, `defineHook` and the types a tool or hook consumes (`ToolSpec`, `ToolContext`, `HookSpec`, … — see `src/index.ts`).

This package does **NOT own the tool registry** — that belongs to the engine's loader. As a result, having **multiple copies of the SDK around is harmless**: each plugin resolves its own copy (and its own `zod`, `ai`, …) with no shared-singleton coupling.

## Data-boundary principle (the cardinal rule)

`defineTool` serializes the `zod` schema (`parameters`) → JSON Schema **at module load, INSIDE the plugin's realm** (`toJsonSchema` in `src/contract.ts`). The engine receives **only data** (`inputSchema`, a plain object) plus the `execute` function.

- A **live** zod object **must NEVER cross the** engine↔plugin **boundary**.
- **Never** do a cross-package `instanceof` (it would fail: different classes from different copies of the SDK/zod).
- The types in `context-types.ts` are **structural** interfaces that mirror the engine's concrete shapes (`AuditLogger`, `Attachment`, `ConversationStateApi`, `ToolApiKeys`): the `InstanceSlug` brand is type-level only (phantom field), so the engine's concrete objects satisfy the contract **without importing the internals**.

## Text people read vs text the model reads

Every authoring field belongs to one audience. Model-facing text (`description` of a
tool, `parameters` `.describe()`, `inputExamples`) stays one string: it is prompt. Text a
person reads in the panel or the marketplace (`summary` of a tool or hook, `label` and
`description` of a `requiredSecrets` field, plugin `displayName`/`description`) is a
`LocalizedText` (`src/localized-text.ts`), validated at load with the engine's own tag
pattern. A new person-facing field is a `LocalizedText` from the start; `category` and
`choices` are ids and values, not text. A new localized field needs an engine that
accepts it, so say in the CHANGELOG which engine version it requires.

## Ironclad rules

1. **Zero imports from the engine internals.** The SDK is self-contained; shared types are re-declared structurally in `context-types.ts`.
2. **Must stay stateless.** No `Map`/registries/singletons/module state. Only pure functions + types.
3. **Must ship built.** `main: dist/index.js`, `types: dist/index.d.ts`. The `prepare` script builds `dist` so the package is consumable as a **git-dependency** (npm runs `prepare` when cloning the git ref).

## How it is consumed

The engine and the plugins reference it as a **git-dependency** with a tag:

```
git+https://github.com/polyant-ai/polyant-sdk.git#<tag>
```

Each one resolves its **own** copy (see the data-boundary principle above). `zod` is a **peer dependency** — provided by the consumer.

## Versioning

The **SDK version IS the compatibility contract.** It binds to `plugin.json.engine` (semver range of supported engine versions) through the engine version.

- **Deliberate** semver bumps; **breaking the tool contract = major bump.**
- A release bumps `version` in `package.json`, tags `vX.Y.Z` and pushes the tag;
  consumers then move their git ref to `#vX.Y.Z`.

## Entry points

Two, and the second must not leak into the first:

- **`.`** (`src/index.ts`) — the authoring contract. Runtime-agnostic, no Node built-ins
  beyond the `Buffer` type, no I/O.
- **`./dev`** (`src/dev/`) — the dev-session client runtime: it speaks the engine's dev
  bridge over a WebSocket so a local `*.tool.ts` executes inside a remote agent. Node-only
  (`node:crypto`, `node:fs`), and nothing in `.` imports it, which is why `engines` stays
  `>=20` even though its DEFAULT transport (the global `WebSocket`) needs Node 22 — on an
  older Node the caller injects `webSocketImpl`.

`src/dev/protocol.ts` is a **verbatim port** of the engine's `dev-mode/dev-protocol.ts`,
relicensed Apache-2.0 for this package. The two copies are the same contract: change one
and you must change the other, and an incompatible change bumps `DEV_PROTOCOL_VERSION` in
both — the engine's handshake rejects a mismatch explicitly. `SDK_VERSION`
(`src/dev/sdk-version.ts`) is a literal because this entry must import from `dist/` with no
filesystem read; `sdk-version.test.ts` fails when it drifts from `package.json`.

A `*.test-fixture.ts` file is test-only shared code, excluded from `tsconfig.build.json`
alongside `*.test.ts` — the fake socket lives there because more than one test needs it.

## How to add/change the contract

Edit `src/contract.ts`, `src/context-types.ts` or `src/hooks.ts`, re-export from
`src/index.ts`, update the tests; Versioning decides the bump.

## Working practice

- Inspect the code, tests and history before editing; follow the nearest existing pattern.
- Make it work, then make it good: before asking for review, simplify — reuse what
  exists, remove duplication and dead code, keep the diff small.
- Verify with `npm run typecheck`, `npm test` and `npm run build`; report what could not run.
- Branch from `develop` as `feat/…`, `fix/…`, `feature/…`, `bugfix/…` or `hotfix/…` (other
  names are rejected) and open the PR to `develop`; `main` and `develop` are protected
  and require the `CI` check.
- Write the PR in English with `.github/PULL_REQUEST_TEMPLATE.md`. Never merge, tag,
  publish or deploy unless explicitly asked.
