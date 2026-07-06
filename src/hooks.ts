// SPDX-License-Identifier: Apache-2.0
//
// Hook function contract (v1.2.0). A hook function is deterministic lifecycle
// code — distinct from a tool (never LLM-invoked). It reuses the v1.1.0
// structural context primitives; the only hook-specific runtime capability is
// `ai` (an LLM accessor bound by the engine to the instance's model).
import type {
  ConversationStateApi,
  ConversationHistoryApi,
  ConversationMessage,
  ToolApiKeys,
  AuditLogger,
} from "./context-types.js";
import {
  normalizeRequiredSecrets,
  type RequiredSecretsInput,
  type RequiredSecretSpec,
} from "./contract.js";

/** Conversation lifecycle events a hook can subscribe to. */
export type HookEvent =
  | "conversation_start"
  | "message_received"
  | "response_generated"
  | "response_sent";

/** Server-built event payload (the only trusted data source for a hook). */
export interface HookEventPayload {
  instance: { slug: string };
  conversation: { id: string };
  channel: { type: string; id: string };
  user: { name: string };
  message: { text: string };
  /** Present only on response_generated / response_sent. */
  response?: { text: string };
}

/** LLM access bound to the instance's configured model, via the engine ai-gateway. */
export interface HookAi {
  chat(input: {
    messages: ConversationMessage[];
    system?: string;
    tier?: "fast" | "standard" | "heavy";
  }): Promise<string>;
}

/**
 * Everything a hook handler receives. Read-mostly; the only mutations are via
 * `state` (commit-on-success) and the returned {@link HookResult}. Modelled on
 * {@link ToolContext}, plus `event` / `payload` / `ai`.
 *
 * NOTE on required-ness vs {@link ToolContext}: `conversation` and `secrets` are
 * REQUIRED here, whereas `ToolContext` declares `conversation?` / `secrets?`
 * optional (for backward-compat with engines predating the history accessor).
 * Hook functions are a v1.2.0 feature: any engine that runs hooks always builds
 * both, so handlers need no undefined-guard.
 */
export interface HookContext {
  event: HookEvent;
  payload: HookEventPayload;
  /** Read-only recent conversation history (same accessor tools receive). */
  conversation: ConversationHistoryApi;
  /** Shared per-conversation state — READ + WRITE. */
  state: ConversationStateApi;
  secrets: Record<string, string>;
  instance: { slug: string; provider?: string; model?: string; flags: Record<string, boolean> };
  apiKeys?: ToolApiKeys;
  ai: HookAi;
  audit: AuditLogger;
  abortSignal?: AbortSignal;
}

/** What a hook may return to influence the turn. `void` = no effect. */
export type HookResult =
  | void
  | {
      /** Pre-LLM (conversation_start, message_received): skip the LLM, reply with this. */
      halt?: { message: string };
      /**
       * On `response_generated`: replace the LLM reply with this. The engine only
       * honors it when the hook declares `mutatesResponse: true` (which makes the
       * engine run the turn non-streamed); on a streamed turn without that flag the
       * tokens have already been sent, so the engine ignores it with a warning
       * rather than silently. This is a RUNTIME contract enforced by the engine —
       * it cannot be checked statically here, since the value is a handler return,
       * not a static field.
       */
      replaceResponse?: { message: string };
      /** Pre-LLM: extra one-shot context appended to this turn's LLM input. */
      injectContext?: string;
    };

/**
 * Author-facing hook spec — what you pass to {@link defineHook}. `requiredSecrets`
 * is normalized (and validated) at definition time, exactly as {@link ToolSpec}.
 */
export interface HookSpec {
  name: string;
  description: string;
  /** Scoped secrets, same spec shape (and load-time validation) as tools. */
  requiredSecrets?: RequiredSecretsInput;
  /** Declare `true` if the handler may return `replaceResponse`, so the engine
   *  disables token streaming for affected turns (declare-and-buffer). */
  mutatesResponse?: boolean;
  handler: (ctx: HookContext) => Promise<HookResult> | HookResult;
}

/**
 * The serialized definition the engine loader collects. `requiredSecrets` is the
 * NORMALIZED `RequiredSecretSpec[]` (mirrors {@link ToolDefinition}).
 */
export interface HookFunctionDefinition {
  name: string;
  description: string;
  requiredSecrets: RequiredSecretSpec[];
  mutatesResponse?: boolean;
  handler: (ctx: HookContext) => Promise<HookResult> | HookResult;
}

/**
 * Author a hook function. Mirrors {@link defineTool}: normalizes + validates
 * `requiredSecrets` at module load (throws on malformed specs), returning the
 * definition the engine loader collects.
 */
export function defineHook(spec: HookSpec): HookFunctionDefinition {
  return {
    name: spec.name,
    description: spec.description,
    requiredSecrets: normalizeRequiredSecrets(spec.requiredSecrets, spec.name),
    mutatesResponse: spec.mutatesResponse,
    handler: spec.handler,
  };
}
