// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createCtxProxy } from "./ctx-proxy.js";
import type { InlineToolContext } from "./protocol.js";

const inline = (over: Partial<InlineToolContext> = {}): InlineToolContext => ({
  instanceId: "acme-bot",
  conversationId: "telegram:1",
  memoryScopeKey: "",
  provider: "anthropic",
  secrets: { api_key: "s" },
  state: { a: 1 },
  ...over,
});

describe("createCtxProxy", () => {
  it("serves state reads from the snapshot, synchronously", () => {
    const { ctx } = createCtxProxy({ inline: inline(), rpc: vi.fn() });
    expect(ctx.state?.get("a")).toBe(1);
    expect(ctx.state?.getAll()).toEqual({ a: 1 });
    expect(ctx.state?.get("missing")).toBeUndefined();
  });

  it("records writes in order and reads back its own write", () => {
    const proxy = createCtxProxy({ inline: inline(), rpc: vi.fn() });
    proxy.ctx.state?.set("b", 2);
    expect(proxy.ctx.state?.get("b")).toBe(2);
    proxy.ctx.state?.delete("a");
    expect(proxy.ctx.state?.getAll()).toEqual({ b: 2 });
    expect(proxy.stateWrites()).toEqual([
      { op: "set", key: "b", value: 2 },
      { op: "delete", key: "a" },
    ]);
  });

  it("accumulates audit entries and returns void from log", () => {
    const proxy = createCtxProxy({ inline: inline(), rpc: vi.fn() });
    expect(proxy.ctx.audit.log({ action: "did-a-thing" })).toBeUndefined();
    proxy.ctx.audit.log({ action: "and-another", success: false, error: "nope" });
    expect(proxy.auditEntries()).toEqual([
      { action: "did-a-thing" },
      { action: "and-another", success: false, error: "nope" },
    ]);
  });

  it("hands back copies, so a caller cannot mutate what will be sent", () => {
    const proxy = createCtxProxy({ inline: inline(), rpc: vi.fn() });
    proxy.ctx.state?.set("b", 2);
    proxy.stateWrites().push({ op: "delete", key: "smuggled" });
    expect(proxy.stateWrites()).toHaveLength(1);
  });

  it("exposes ids, provider, secrets and the channel identity inline", () => {
    const { ctx } = createCtxProxy({
      inline: inline({ channel: { type: "telegram", id: "42", userName: "ada" } }),
      rpc: vi.fn(),
    });
    expect(ctx.instanceId).toBe("acme-bot");
    expect(ctx.conversationId).toBe("telegram:1");
    expect(ctx.provider).toBe("anthropic");
    expect(ctx.secrets).toEqual({ api_key: "s" });
    expect(ctx.state?.channel).toEqual({ type: "telegram", id: "42", userName: "ada" });
  });

  it("routes the three async APIs through the rpc, with their arguments", async () => {
    const rpc = vi.fn().mockResolvedValue([{ role: "user", content: "hi" }]);
    const { ctx } = createCtxProxy({ inline: inline(), rpc });

    await ctx.conversation?.getRecentMessages(3, { roles: ["user"] });
    expect(rpc).toHaveBeenCalledWith("conversation.getRecentMessages", [3, { roles: ["user"] }]);

    rpc.mockResolvedValue({ ok: true, token: "t" });
    await expect(ctx.oauth?.requireToken("google")).resolves.toEqual({ ok: true, token: "t" });
    expect(rpc).toHaveBeenCalledWith("oauth.requireToken", ["google"]);

    rpc.mockResolvedValue({ status: "action_required" });
    await ctx.oauth?.connectResult("google");
    expect(rpc).toHaveBeenCalledWith("oauth.connectResult", ["google"]);
  });

  it("revives a JSON-serialized Buffer back into an attachment Buffer", () => {
    const { ctx } = createCtxProxy({
      inline: inline({
        attachments: [
          { type: "file", fileName: "a.txt", data: { type: "Buffer", data: [104, 105] } },
          { type: "image", url: "https://example.test/a.png" },
        ],
      }),
      rpc: vi.fn(),
    });
    expect(Buffer.isBuffer(ctx.attachments?.[0].data)).toBe(true);
    expect(ctx.attachments?.[0].data?.toString("utf8")).toBe("hi");
    expect(ctx.attachments?.[1]).toEqual({ type: "image", url: "https://example.test/a.png" });
  });
});
