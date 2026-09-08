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

/** Result of {@link OAuthAccessApi.requireToken}: a valid access token, or a
 *  ready-to-return `action_required` result (the connect link) the tool hands
 *  straight back to the caller when the user isn't connected. */
export type OAuthTokenResult =
  | { ok: true; token: string }
  | { ok: false; result: Record<string, unknown> };

/**
 * Tool-facing OAuth accessor exposed as `ctx.oauth`. The engine owns the broker
 * (provider registry, /oauth/:provider/callback, encrypted per-conversation token
 * vault, refresh); a tool only asks for a valid token or the connect link — it
 * never sees the client_secret nor handles the redirect. Declare the provider's
 * client credentials with {@link oauthRequiredSecrets}. Absent on engines without
 * OAuth support, so plugins MUST handle undefined.
 */
export interface OAuthAccessApi {
  /** A valid access token for `provider` on this conversation (refreshing an
   *  expired one), or `{ ok:false, result }` carrying the connect-link result. */
  requireToken(provider: string): Promise<OAuthTokenResult>;
  /** The `action_required` connect-link result for `provider` — use it on a 401
   *  to prompt a reconnect. */
  connectResult(provider: string): Promise<Record<string, unknown>>;
}

/**
 * How much of the knowledge base the current agent grants to tool code. A
 * LEVEL, not a set of flags: the three are monotone (`manage` ⊃ `write` ⊃
 * `read`), so a state like "writes but cannot read" cannot be configured.
 * Readable as {@link KnowledgeApi.level} so a tool can tell the model what it
 * is able to do instead of provoking a refusal.
 */
export type KnowledgeAccessLevel = "read" | "write" | "manage";

/** Who wrote a knowledge document. Engine-assigned and NEVER a tool input —
 *  it is the field ownership is decided on, so a tool that could set it could
 *  claim someone else's document. `panel` is a human upload, `agent` a core
 *  knowledge tool, `plugin` a plugin tool (with `originRef` naming which). */
export type KnowledgeOrigin = "panel" | "agent" | "plugin";

/** Why a knowledge mutation was refused. Returned, never thrown: a throw inside
 *  a plugin tool becomes a broken turn with nothing the model can act on. */
export type KnowledgeDenialReason =
  /** The agent's granted level is below the one this call needs. */
  | "not_granted"
  /** The document exists but was written by someone else (see
   *  {@link KnowledgeOrigin}); overwriting it needs `manage`. */
  | "not_owned"
  /** No document with that filename for this agent. */
  | "not_found"
  /** The resulting document exceeds the engine's per-document size cap. */
  | "too_large"
  /** The knowledge base is already at the engine's per-agent document cap, so a
   *  NEW document cannot be created. Updating an existing one is unaffected. */
  | "limit_reached"
  /** The engine declined the content itself (unsupported type, ingestion refusal). */
  | "unsupported";

/** One retrieved chunk from a hybrid (vector + full-text) knowledge search. */
export interface KnowledgeSearchHit {
  /** The chunk's text. */
  content: string;
  /** Fused relevance score — comparable WITHIN one result set only. */
  score: number;
  /** Filename of the parent document. */
  source: string;
  /** The chunk's position inside its parent document (0-based). */
  chunkIndex: number;
}

/** Options for {@link KnowledgeApi.search}. */
export interface KnowledgeSearchOptions {
  /** Maximum hits to return. Engine default when omitted. */
  limit?: number;
}

/** A knowledge document without its content. */
export interface KnowledgeDocumentSummary {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Ingestion status as the engine reports it (e.g. pending/ready/failed). */
  status: string;
  origin: KnowledgeOrigin;
  /** Which writer produced it — a plugin namespace for `plugin`, else `null`. */
  originRef: string | null;
  /** ISO-8601, or `null` when the engine has no timestamp for it. */
  updatedAt: string | null;
}

/** A knowledge document with its full raw content. */
export interface KnowledgeDocumentContent extends KnowledgeDocumentSummary {
  content: string;
}

/** Options for {@link KnowledgeApi.list}. */
export interface KnowledgeListOptions {
  /** Restrict to documents from these origins. Omitted ⇒ all origins. */
  origins?: readonly KnowledgeOrigin[];
  /** Restrict to documents this caller itself wrote. */
  mineOnly?: boolean;
}

/** Outcome of a knowledge mutation: the affected document, or a refusal reason. */
export type KnowledgeWriteResult =
  | { ok: true; document: KnowledgeDocumentSummary; created: boolean }
  | { ok: false; reason: KnowledgeDenialReason };

/**
 * Read, write and manage the CURRENT agent's knowledge base, exposed as
 * `ctx.knowledge`.
 *
 * Three properties are the contract, not implementation detail:
 *
 * - **The agent is implicit.** No method takes an instance: the accessor is
 *   closed over the agent of the running turn, so tool code cannot name another
 *   agent's knowledge base.
 * - **Presence IS the read grant.** The engine omits `ctx.knowledge` entirely
 *   when the agent grants no access, so reads need no status wrapper — plugins
 *   MUST handle `undefined`. Mutations still answer with
 *   {@link KnowledgeWriteResult} because `write` and `manage` are separate
 *   grants that can be refused while reading is allowed.
 * - **Ownership is engine-assigned.** A `write`-level caller creates documents
 *   and updates the ones it wrote; a document from the panel or another writer
 *   answers `not_owned` until the level is `manage`.
 *
 * Every call is audited by the engine, so a plugin cannot omit the trail. There
 * is deliberately NO method to erase the whole knowledge base: wiping an
 * agent's knowledge is a panel operation with a human behind it.
 */
export interface KnowledgeApi {
  /** What this agent grants — check it before offering a mutation to the model. */
  readonly level: KnowledgeAccessLevel;
  /** Hybrid (vector + full-text) search over the agent's documents, most
   *  relevant first. Empty array when nothing matches. */
  search(query: string, opts?: KnowledgeSearchOptions): Promise<KnowledgeSearchHit[]>;
  /** One document with its full content by exact filename, or `null`. */
  get(filename: string): Promise<KnowledgeDocumentContent | null>;
  /** The agent's documents without their content. */
  list(opts?: KnowledgeListOptions): Promise<KnowledgeDocumentSummary[]>;
  /** Create the document, or replace the content of one this caller owns.
   *  `mimeType` applies on creation only. Needs `write`. */
  write(input: {
    filename: string;
    content: string;
    mimeType?: string;
  }): Promise<KnowledgeWriteResult>;
  /** Append to a document this caller owns, creating it when absent. Needs `write`. */
  append(input: { filename: string; content: string }): Promise<KnowledgeWriteResult>;
  /** Delete ONE document by filename. Needs `manage`. */
  delete(filename: string): Promise<KnowledgeWriteResult>;
  /** Re-chunk and re-embed one document — the repair for a failed ingestion or
   *  an embedder change. Needs `manage`. */
  reingest(filename: string): Promise<KnowledgeWriteResult>;
}

/**
 * Runtime context passed to every tool's `execute(input, ctx)`.
 * Created by the engine and handed into the plugin's execute — the plugin only
 * reads/calls its members, so nothing here requires shared runtime identity.
 */
export interface ToolContext {
  /** Instance identifier (slug, not UUID). */
  instanceId: InstanceSlug;
  /** Per-instance decrypted secrets, SCOPED to the keys this tool declared in
   *  `requiredSecrets` (least-privilege, enforced by the engine): a tool only ever
   *  sees the secrets it declared; undeclared keys are absent. To read a secret,
   *  declare it in `requiredSecrets`. */
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
  /** Per-conversation OAuth access (tokens brokered + refreshed by the engine).
   *  Absent on engines without OAuth support — plugins MUST handle undefined. */
  oauth?: OAuthAccessApi;
  /** Read/write/manage access to THIS agent's knowledge base. Present only when
   *  the agent grants access (see {@link KnowledgeApi}), so its very presence is
   *  the read grant — plugins MUST handle undefined. */
  knowledge?: KnowledgeApi;
}
