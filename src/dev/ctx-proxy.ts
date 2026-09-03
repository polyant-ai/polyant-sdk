// SPDX-License-Identifier: Apache-2.0

/**
 * The local half of the ctx bridge: turns the inline `ctx` of a `tool.invoke`
 * frame into a {@link ToolContext} that behaves like the in-process one.
 *
 * The deciding constraint is that {@link ConversationStateApi} is SYNCHRONOUS —
 * `ctx.state.get(k)` cannot await a network round trip — so the ctx is split in
 * three classes, exactly as the engine's `dev-ctx-bridge.ts` describes:
 *
 *   1. inline data (ids, provider, scoped secrets, apiKeys, attachments);
 *   2. snapshot + write-back for the sync APIs (`state`, `audit.log`): reads are
 *      served from the snapshot taken at invocation time — which is what the
 *      tool would see in-process, since nothing else writes state during a
 *      single `execute` — and writes are recorded in order and returned with
 *      the result, so they ride the engine's commit-on-success;
 *   3. true RPC for what was already async (`conversation`, `oauth`).
 */

import type {
  Attachment,
  ChannelStateIdentity,
  ConversationMessage,
  ConversationStateApi,
  InstanceSlug,
  OAuthTokenResult,
  RecentMessagesOptions,
  ToolApiKeys,
  ToolContext,
} from "../context-types.js";
import type { AuditEntryPayload, CtxOp, InlineToolContext, StateWrite } from "./protocol.js";

/**
 * The ctx a dev-served tool receives. Identical to {@link ToolContext} plus
 * `memoryScopeKey`, which the engine's own `ToolContext` carries and puts on the
 * wire but which is not part of the published authoring contract — a dev tool
 * should not start depending on it, so it is typed here and nowhere else.
 */
export interface DevToolContext extends ToolContext {
  readonly memoryScopeKey?: string;
}

/** Performs one RPC-class ctx op for the call currently in flight. */
export type CtxRpc = (op: CtxOp, args: unknown[]) => Promise<unknown>;

export interface CtxProxy {
  readonly ctx: DevToolContext;
  /** Writes recorded so far, in order — read after `execute` resolves. */
  stateWrites(): StateWrite[];
  /** Audit entries recorded so far, in order. */
  auditEntries(): AuditEntryPayload[];
}

/**
 * Build the proxy for one invocation. The returned accessors are snapshots of
 * the recording buffers, so a caller cannot mutate what it is about to send.
 */
export function createCtxProxy(opts: { inline: InlineToolContext; rpc: CtxRpc }): CtxProxy {
  const { inline, rpc } = opts;
  const writes: StateWrite[] = [];
  const audit: AuditEntryPayload[] = [];
  // Local mirror of the snapshot: a `set` followed by a `get` inside the same
  // execute must read back the new value, exactly as the real buffer does.
  const local = new Map<string, unknown>(Object.entries(inline.state));

  const state: ConversationStateApi = {
    get(key: string): unknown {
      return local.get(key);
    },
    set(key: string, value: unknown): void {
      local.set(key, value);
      writes.push({ op: "set", key, value });
    },
    getAll(): Record<string, unknown> {
      return Object.fromEntries(local);
    },
    delete(key: string): void {
      local.delete(key);
      writes.push({ op: "delete", key });
    },
    get channel(): ChannelStateIdentity | undefined {
      return inline.channel as ChannelStateIdentity | undefined;
    },
  };

  const ctx: DevToolContext = {
    instanceId: inline.instanceId as InstanceSlug,
    conversationId: inline.conversationId,
    memoryScopeKey: inline.memoryScopeKey,
    provider: inline.provider,
    secrets: inline.secrets,
    apiKeys: inline.apiKeys as ToolApiKeys | undefined,
    attachments: inline.attachments ? inline.attachments.map(reviveAttachment) : undefined,
    state,
    audit: {
      log(entry: AuditEntryPayload): void {
        audit.push(entry);
      },
    },
    conversation: {
      async getRecentMessages(n: number, o?: RecentMessagesOptions): Promise<ConversationMessage[]> {
        return (await rpc("conversation.getRecentMessages", [n, o])) as ConversationMessage[];
      },
    },
    oauth: {
      async requireToken(provider: string): Promise<OAuthTokenResult> {
        return (await rpc("oauth.requireToken", [provider])) as OAuthTokenResult;
      },
      async connectResult(provider: string): Promise<Record<string, unknown>> {
        return (await rpc("oauth.connectResult", [provider])) as Record<string, unknown>;
      },
    },
  };

  return {
    ctx,
    stateWrites: () => [...writes],
    auditEntries: () => [...audit],
  };
}

/**
 * `Attachment.data` is a `Buffer`, and JSON turns it into
 * `{ type: "Buffer", data: number[] }`. Rebuild it, so a dev tool reading
 * `a.data.length` sees bytes and not an object — the engine already omits any
 * attachment above its inline cap, so what arrives here is small by
 * construction.
 */
function reviveAttachment(raw: unknown): Attachment {
  const a = raw as Attachment & { data?: unknown };
  const data = a.data as { type?: string; data?: number[] } | undefined;
  if (data && data.type === "Buffer" && Array.isArray(data.data)) {
    return { ...a, data: Buffer.from(data.data) } as Attachment;
  }
  return a as Attachment;
}
