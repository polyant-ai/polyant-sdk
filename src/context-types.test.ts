// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import type {
  ToolContext,
  ConversationHistoryApi,
  ConversationMessage,
  ConversationRole,
  RecentMessagesOptions,
} from "./context-types.js";

/**
 * Reference in-memory implementation of the documented `getRecentMessages`
 * contract. This is the executable spec the real engine accessor must honor:
 * filter-by-role FIRST, then take the last `n` (oldest → newest); `n === 0`
 * (and `n < 0`) returns ALL matching messages. The stored feed already includes
 * the current in-flight user turn as its last element.
 */
function fakeHistory(feed: ConversationMessage[]): ConversationHistoryApi {
  return {
    async getRecentMessages(n: number, opts?: RecentMessagesOptions) {
      const roles = opts?.roles;
      const filtered =
        roles && roles.length > 0 ? feed.filter((m) => roles.includes(m.role)) : feed;
      return n > 0 ? filtered.slice(-n) : filtered;
    },
  };
}

const stubCtx = (over: Partial<ToolContext> = {}): ToolContext => ({
  instanceId: "inst" as ToolContext["instanceId"],
  audit: { log() {} },
  ...over,
});

const FEED: ConversationMessage[] = [
  { role: "system", content: "you are helpful" },
  { role: "user", content: "book me a flight" },
  { role: "assistant", content: "sure, where to?" },
  { role: "tool", content: "{\"results\":[]}" },
  { role: "assistant", content: "no flights found" },
  { role: "user", content: "try tomorrow instead" }, // current in-flight turn
];

describe("ConversationHistoryApi — contract semantics", () => {
  it("is wired on ctx.conversation and returns messages oldest → newest", async () => {
    const ctx = stubCtx({ conversation: fakeHistory(FEED) });
    const msgs = await ctx.conversation!.getRecentMessages(3);
    expect(msgs.map((m) => m.content)).toEqual([
      "{\"results\":[]}",
      "no flights found",
      "try tomorrow instead",
    ]);
  });

  it("includes the current in-flight user turn as the last element", async () => {
    const ctx = stubCtx({ conversation: fakeHistory(FEED) });
    const msgs = await ctx.conversation!.getRecentMessages(2);
    expect(msgs.at(-1)).toEqual({ role: "user", content: "try tomorrow instead" });
  });

  it("filters by role FIRST, then takes the last n", async () => {
    const ctx = stubCtx({ conversation: fakeHistory(FEED) });
    const roles: ConversationRole[] = ["user", "assistant"];
    const msgs = await ctx.conversation!.getRecentMessages(3, { roles });
    // `tool` and `system` are dropped before the cut, so 3 relevant turns survive.
    expect(msgs).toEqual([
      { role: "assistant", content: "sure, where to?" },
      { role: "assistant", content: "no flights found" },
      { role: "user", content: "try tomorrow instead" },
    ]);
  });

  it("returns ALL matching messages when n === 0", async () => {
    const ctx = stubCtx({ conversation: fakeHistory(FEED) });
    const users = await ctx.conversation!.getRecentMessages(0, { roles: ["user"] });
    expect(users).toEqual([
      { role: "user", content: "book me a flight" },
      { role: "user", content: "try tomorrow instead" },
    ]);
  });

  it("treats an empty roles array as no filter (all roles)", async () => {
    const ctx = stubCtx({ conversation: fakeHistory(FEED) });
    const all = await ctx.conversation!.getRecentMessages(0, { roles: [] });
    expect(all).toHaveLength(FEED.length);
  });

  it("a ToolContext without `conversation` is still valid (graceful degradation)", () => {
    const ctx = stubCtx();
    // Optional field: absent on engines that don't implement it.
    expect(ctx.conversation).toBeUndefined();
  });
});
