# Design — Read-only conversation history on `ToolContext`

- **Issue:** [#1](https://github.com/polyant-ai/polyant-sdk/issues/1) — `feat: expose read-only conversation history on ToolContext`
- **Date:** 2026-07-04
- **Methodology:** github-flow (branch `feat/issue-1-expose-conversation-history` → PR → `main`)
- **Version impact:** additive optional field ⇒ **minor bump** `1.0.0` → `1.1.0`, tag `v1.1.0`

## Problem

Engine-internal tools can read the conversation message store directly. Plugin tools cannot: the SDK boundary (`ToolContext`) exposes `state`, `secrets`, `apiKeys`, `audit`, `attachments` — but **no way to read recent conversation turns**, not even the current user turn.

Some tools need that context to decide without re-asking the user. Canonical case: a tool that runs a background LLM classification over what the user already said (topic / intent / category) and uses the result to parametrize a downstream call. Today such ports degrade — empty context ⇒ the classifier falls into its "unknown" branch ⇒ the downstream call loses a filter it used to have. Safe, but a real feature loss that silently diverges from in-engine behavior.

## Approach

Three approaches were on the table (the first two are the rejected alternatives from the issue):

1. **LLM-provided parameter** — the model passes the relevant text as a tool argument. Rejected: untrusted and defeats the purpose (we want to classify what the user *actually* said, deterministically).
2. **Seed history into `ctx.state`** each turn. Rejected: forces the engine to eagerly copy messages every turn for every conversation, whether or not any tool reads them.
3. **Optional, read-only accessor mirrored structurally on `ToolContext`** (chosen) — consistent with how `ConversationStateApi` is already modelled. Lazy (the engine wires it only when building `ctx`; the plugin pulls messages on demand), no eager copy, no module state. The SDK stays stateless; the change is purely additive so plugins on older engines degrade gracefully by handling `undefined`.

## Contract surface

New declarations in `src/context-types.ts` (structural interfaces only — no runtime logic):

```ts
/** Role of a persisted conversation message. */
export type ConversationRole = "user" | "assistant" | "system" | "tool";

/** A single persisted conversation message, text-only content. */
export interface ConversationMessage {
  role: ConversationRole;
  content: string;
}

/** Options for {@link ConversationHistoryApi.getRecentMessages}. */
export interface RecentMessagesOptions {
  /** Restrict to these roles, applied BEFORE the `n` cut.
   *  Omitted or empty array ⇒ all roles. */
  roles?: readonly ConversationRole[];
}

/**
 * Read-only access to the current conversation's recent messages.
 * Mirrors the engine's concrete history accessor STRUCTURALLY (as for
 * ConversationStateApi): the SDK never imports engine internals.
 */
export interface ConversationHistoryApi {
  /**
   * The most recent persisted messages, oldest → newest, text-only content.
   * Includes the CURRENT (in-flight) user turn as the last element.
   *
   * Filtering: when `opts.roles` is provided, the engine filters by role FIRST,
   * then returns the last `n` matching messages. `n === 0` returns ALL matching
   * messages (no cap); `n < 0` is treated as `0`.
   */
  getRecentMessages(n: number, opts?: RecentMessagesOptions): Promise<ConversationMessage[]>;
}
```

New optional field on `ToolContext` (same file):

```ts
  /** Read-only accessor for the recent conversation history.
   *  Absent on engines that don't implement it — plugins MUST handle undefined. */
  conversation?: ConversationHistoryApi;
```

Re-exports added to `src/index.ts`: `ConversationRole`, `ConversationMessage`, `RecentMessagesOptions`, `ConversationHistoryApi`.

## Design decisions

- **Named exported types** instead of the issue's inline `Array<{ role; content }>`: the plugin author must be able to type the result and build the role filter with autocomplete. Reusable and self-documenting, matching the SDK's convention of naming its structural types.
- **Options object** (`opts?: { roles? }`) instead of a second positional parameter: extensible without breaking the contract if more knobs are added later.
- **Current turn included** as the last element — this is the crux of the feature's value (classify what the user just said) and avoids passing untrusted text as an LLM parameter.
- **Role union `user | assistant | system | tool`** with an optional per-call filter: the store may contain all four; the caller declares which it wants. Default (no filter) returns all.
- **`n` semantics: filter-then-take-`n`** so `getRecentMessages(5, { roles: ["user","assistant"] })` yields up to 5 relevant turns regardless of interleaved `tool` results; `n === 0` returns all matching.
- **No change to `src/contract.ts`**: `execute(input, ctx)` already carries `ctx`; adding an optional field to `ToolContext` does not touch the serialization boundary or `defineTool`.
- **Structural mirror constraint**: the engine's concrete `conversation` object must be *assignable* to `ConversationHistoryApi` — same rule as every other mirrored type in `context-types.ts`. In particular the engine's concrete return must narrow `role` to `ConversationRole`. That is the engine's responsibility; this file is the authoritative contract it mirrors. No cross-package `instanceof` is ever involved.

## Testing

`context-types.ts` is types-only, so coverage is split:

1. **Compile-time** (enforced by `npm run typecheck` + `npm run build`):
   - a `ToolContext` *without* `conversation` still typechecks (optional field ⇒ backward compatible — already exercised by the existing `stubCtx` helper);
   - an engine-like object literal is assignable to `ConversationHistoryApi`.
2. **Runtime reference/contract test** (vitest, `src/context-types.test.ts` or extending `contract.test.ts`, following the existing `stubCtx` style): a fake in-memory implementation of `ConversationHistoryApi` wired onto a stub `ctx.conversation`, exercising the documented semantics as an executable spec the real engine must honor:
   - current in-flight user turn is the last element;
   - `roles` filter is applied before the `n` cut (filter-then-take-`n`);
   - `n === 0` returns all matching messages;
   - a `ctx` with `conversation: undefined` is a valid `ToolContext` (graceful-degradation path).

   This test verifies the *interface is usable and its contract is coherent* — it does not (and cannot) test the engine's real implementation, which lives in `polyant-enterprise`.

## Out of scope / non-goals

- Write access or mutation of history (accessor is strictly read-only).
- Non-text content (attachments, tool-call payloads): `content` is text-only; attachments remain on `ctx.attachments`.
- Pagination / cursors / time-range queries: YAGNI — `getRecentMessages(n, { roles })` covers the classification use case. Can be extended later via `RecentMessagesOptions` without breaking the contract.
- The engine-side implementation (wiring `ctx.conversation` from the message store) — lives in `polyant-enterprise`; this SDK only declares the structural contract.

## Versioning steps (on completion)

1. Bump `version` in `package.json` to `1.1.0`.
2. Commit, open PR to `main` (`Closes #1`), merge after review + green CI.
3. Tag `v1.1.0`, push the tag.
4. Consumers (engine + plugins) bump the git ref to `#v1.1.0` when they adopt it.
