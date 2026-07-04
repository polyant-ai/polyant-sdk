// SPDX-License-Identifier: Apache-2.0

/**
 * SDK-local STRUCTURAL interfaces for the engine-internal objects that flow into
 * a tool via {@link ToolContext}. The plugin SDK must NOT import engine internals,
 * so these mirror the field NAMES and shapes the engine's concrete objects expose
 * — modelling only the members tools actually consume. This IS the stable public
 * contract: the engine's concrete `AuditLogger`, `Attachment`, `ConversationStateApi`,
 * and `ChatRequest["apiKeys"]` structurally satisfy these types.
 */

/** Human-readable instance identifier (the `instances.slug` column).
 *
 * Brand is type-level only (a phantom field, never present at runtime), so this
 * is structurally identical to the engine's `InstanceSlug` — the engine's
 * concrete `ToolContext` objects satisfy this contract without importing engine
 * internals. */
export type InstanceSlug = string & { readonly __brand: "InstanceSlug" };

/** Tool-facing audit API (mirrors engine `audit/audit-logger.ts` AuditLogger). */
export interface AuditLogger {
  log(entry: {
    action: string;
    details?: Record<string, unknown>;
    success?: boolean;
    error?: string;
    durationMs?: number;
    output?: string;
  }): void;
}

/** Attachment shape (mirrors engine `channels/types.ts` Attachment). */
export interface Attachment {
  type: "image" | "file" | "audio" | "video";
  url?: string;
  data?: Buffer;
  mimeType?: string;
  fileName?: string;
}

/** Trusted channel identity seeded under `_channel` (mirrors engine `state.buffer.ts`). */
export interface ChannelStateIdentity {
  type: string;
  id: string;
  userName?: string;
  threadId?: string;
}

/**
 * Tool-facing conversation state API exposed as `ctx.state`
 * (mirrors engine `conversations/state.buffer.ts` ConversationStateApi).
 */
export interface ConversationStateApi {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  getAll(): Record<string, unknown>;
  delete(key: string): void;
  readonly channel: ChannelStateIdentity | undefined;
}

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
 * Read-only access to the current conversation's recent messages. Spec-first
 * structural contract (issue #1): the engine's concrete history accessor is
 * implemented against this shape — as for {@link ConversationStateApi}, the SDK
 * never imports engine internals and no cross-package `instanceof` is involved.
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

/**
 * Per-instance API keys for AI provider calls
 * (mirrors engine `ai-gateway/types.ts` ChatRequest["apiKeys"]).
 */
export interface ToolApiKeys {
  openai?: string;
  anthropic?: string;
  bedrock_api_key?: string;
  bedrock_access_key_id?: string;
  bedrock_secret_access_key?: string;
  bedrock_region?: string;
}

/**
 * Runtime context passed to every tool's `execute(input, ctx)`.
 * Created by the engine and handed into the plugin's execute — the plugin only
 * reads/calls its members, so nothing here requires shared runtime identity.
 */
export interface ToolContext {
  /** Instance identifier (slug, not UUID). */
  instanceId: InstanceSlug;
  /** Per-instance decrypted secrets. */
  secrets?: Record<string, string>;
  /** Audit logger scoped to this tool + instance + conversation. */
  audit: AuditLogger;
  /** Conversation ID for correlation in audit logs. */
  conversationId?: string;
  /** Attachments from the current user message (images, files, etc.). */
  attachments?: Attachment[];
  /** Per-instance API keys for AI provider calls (plugins that call an LLM directly). */
  apiKeys?: ToolApiKeys;
  /** AI provider name (e.g. "openai", "anthropic") for tool-level LLM calls. */
  provider?: string;
  /** Shared per-conversation key/value state (trusted, tool-to-tool). */
  state?: ConversationStateApi;
  /** Read-only accessor for the recent conversation history.
   *  Absent on engines that don't implement it — plugins MUST handle undefined. */
  conversation?: ConversationHistoryApi;
}
