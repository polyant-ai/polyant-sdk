// SPDX-License-Identifier: Apache-2.0

/**
 * The local half of the ctx bridge for HOOKS: turns the inline `ctx` of a
 * `hook.invoke` frame into a {@link HookContext} that behaves like the
 * in-process one.
 *
 * Same three classes as {@link createCtxProxy} — inline data, snapshot with
 * write-back for the synchronous APIs, RPC for what was already async — over a
 * different surface. A hook has no `knowledge`, no `oauth` and no
 * `attachments`; it has `ai.chat` and `instance`, which a tool does not. A
 * single proxy for both would be mostly branches saying "not on this context".
 */

import type {
  ChannelStateIdentity,
  ConversationMessage,
  ConversationStateApi,
  RecentMessagesOptions,
} from "../context-types.js";
import type { HookContext, HookEvent, HookEventPayload } from "../hooks.js";
import type { AuditEntryPayload, CtxOp, InlineHookContext, StateWrite } from "./protocol.js";

/** Performs one RPC-class ctx op for the hook call currently in flight. */
export type HookCtxRpc = (op: CtxOp, args: unknown[]) => Promise<unknown>;

export interface HookCtxProxy {
  readonly ctx: HookContext;
  /** Writes recorded so far, in order — read after the handler resolves. */
  stateWrites(): StateWrite[];
  /** Audit entries recorded so far, in order. */
  auditEntries(): AuditEntryPayload[];
}

export function createHookCtxProxy(opts: {
  inline: InlineHookContext;
  event: HookEvent;
  payload: HookEventPayload;
  rpc: HookCtxRpc;
  abortSignal?: AbortSignal;
}): HookCtxProxy {
  const { inline, event, payload, rpc, abortSignal } = opts;
  const writes: StateWrite[] = [];
  const audit: AuditEntryPayload[] = [];
  // Local mirror of the snapshot, for the same reason as the tool proxy: a
  // `set` followed by a `get` inside one handler must read back the new value.
  const local = new Map<string, unknown>(Object.entries(inline.state));

  const state: ConversationStateApi = {
    get: (key) => local.get(key),
    set(key, value) {
      local.set(key, value);
      writes.push({ op: "set", key, value });
    },
    getAll: () => Object.fromEntries(local),
    delete(key) {
      local.delete(key);
      writes.push({ op: "delete", key });
    },
    get channel(): ChannelStateIdentity | undefined {
      return inline.channel as ChannelStateIdentity | undefined;
    },
  };

  const ctx: HookContext = {
    event,
    payload,
    state,
    secrets: inline.secrets,
    instance: {
      slug: inline.instance.slug,
      provider: inline.instance.provider,
      model: inline.instance.model,
      flags: inline.instance.flags,
    },
    conversation: {
      async getRecentMessages(n: number, o?: RecentMessagesOptions): Promise<ConversationMessage[]> {
        return (await rpc("conversation.getRecentMessages", [n, o])) as ConversationMessage[];
      },
    },
    ai: {
      // The provider and the model are deliberately NOT sent: the engine sets
      // them from the turn. A client that could choose them would be routing a
      // tenant's call at a model their agent never admitted.
      async chat(input): Promise<string> {
        return (await rpc("ai.chat", [input])) as string;
      },
    },
    audit: {
      log(entry: AuditEntryPayload): void {
        audit.push(entry);
      },
    },
    abortSignal,
  };

  return {
    ctx,
    stateWrites: () => [...writes],
    auditEntries: () => [...audit],
  };
}
