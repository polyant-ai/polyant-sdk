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
import type { RequiredSecretsInput } from "./contract.js";

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
 * {@link ToolContext}, plus `event`/`payload`/`ai`.
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
      /** response_generated: replace the LLM reply with this. Requires `mutatesResponse`. */
      replaceResponse?: { message: string };
      /** Pre-LLM: extra one-shot context appended to this turn's LLM input. */
      injectContext?: string;
    };

export interface HookFunctionDefinition {
  name: string;
  description: string;
  /** Scoped secrets, same spec shape as tools. */
  requiredSecrets?: RequiredSecretsInput;
  /** True ⇒ turns with this hook on `response_generated` run non-streamed (declare-and-buffer). */
  mutatesResponse?: boolean;
  handler: (ctx: HookContext) => Promise<HookResult> | HookResult;
}

/** Identity passthrough (mirrors defineTool): the engine consumes this object. */
export function defineHook(def: HookFunctionDefinition): HookFunctionDefinition {
  return def;
}
