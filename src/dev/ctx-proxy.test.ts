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

  it("exposes no ctx.knowledge when the engine sent no grant", () => {
    const rpc = vi.fn();
    const { ctx } = createCtxProxy({ inline: inline(), rpc });
    expect(ctx.knowledge).toBeUndefined();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("proxies every knowledge method over RPC and carries the level inline", async () => {
    const rpc = vi.fn().mockResolvedValue({ ok: true });
    const { ctx } = createCtxProxy({ inline: inline({ knowledgeLevel: "manage" }), rpc });
    // `level` is synchronous, so it must come from the inline ctx, not a call.
    expect(ctx.knowledge!.level).toBe("manage");
    expect(rpc).not.toHaveBeenCalled();

    await ctx.knowledge!.search("rimborsi", { limit: 3 });
    await ctx.knowledge!.get("policy.md");
    await ctx.knowledge!.list({ mineOnly: true });
    await ctx.knowledge!.write({ filename: "notes.md", content: "x" });
    await ctx.knowledge!.append({ filename: "notes.md", content: "y" });
    await ctx.knowledge!.delete("notes.md");
    await ctx.knowledge!.reingest("policy.md");

    expect(rpc.mock.calls).toEqual([
      ["knowledge.search", ["rimborsi", { limit: 3 }]],
      ["knowledge.get", ["policy.md"]],
      ["knowledge.list", [{ mineOnly: true }]],
      ["knowledge.write", [{ filename: "notes.md", content: "x" }]],
      ["knowledge.append", [{ filename: "notes.md", content: "y" }]],
      ["knowledge.delete", ["notes.md"]],
      ["knowledge.reingest", ["policy.md"]],
    ]);
  });

  it("puts an artifact over RPC with its bytes as base64 and answers the handle", async () => {
    const rpc = vi.fn().mockResolvedValue("artifact_1");
    const { ctx } = createCtxProxy({ inline: inline(), rpc });
    const handle = await ctx.artifacts.put(
      { buffer: Buffer.from("%PDF-1.7"), filename: "q.pdf", mime: "application/pdf" },
      60_000,
    );
    expect(handle).toBe("artifact_1");
    await ctx.artifacts.put({ buffer: Buffer.from("x"), filename: "x.txt", mime: "text/plain" });
    expect(rpc.mock.calls).toEqual([
      [
        "artifacts.put",
        [{ data: Buffer.from("%PDF-1.7").toString("base64"), filename: "q.pdf", mime: "application/pdf" }, 60_000],
      ],
      // No ttlMs ⇒ no second argument, so the engine applies its own default.
      ["artifacts.put", [{ data: Buffer.from("x").toString("base64"), filename: "x.txt", mime: "text/plain" }]],
    ]);
  });

  it("takes an artifact over RPC and rebuilds the Buffer from base64", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: Buffer.from("%PDF-1.7").toString("base64"),
      filename: "q.pdf",
      mime: "application/pdf",
    });
    const { ctx } = createCtxProxy({ inline: inline(), rpc });
    const taken = await ctx.artifacts.take("artifact_1");
    expect(rpc).toHaveBeenCalledWith("artifacts.take", ["artifact_1"]);
    expect(Buffer.isBuffer(taken?.buffer)).toBe(true);
    expect(taken?.buffer.toString()).toBe("%PDF-1.7");
    expect(taken).toMatchObject({ filename: "q.pdf", mime: "application/pdf" });
  });

  it("answers null when the engine has nothing for the handle", async () => {
    const { ctx } = createCtxProxy({ inline: inline(), rpc: vi.fn().mockResolvedValue(null) });
    expect(await ctx.artifacts.take("artifact_gone")).toBeNull();
  });

  it("rejects with the engine's message when it refuses an artifact", async () => {
    const rpc = vi.fn().mockRejectedValue(new Error("Artifact exceeds the 10 MB limit"));
    const { ctx } = createCtxProxy({ inline: inline(), rpc });
    await expect(
      ctx.artifacts.put({ buffer: Buffer.alloc(1), filename: "big.bin", mime: "application/octet-stream" }),
    ).rejects.toThrow("Artifact exceeds the 10 MB limit");
  });

  it("refuses a put too large for a dev frame locally, without sending it", async () => {
    const rpc = vi.fn();
    const { ctx } = createCtxProxy({ inline: inline(), rpc });
    // 800 000 raw bytes ⇒ ~1 066 668 base64 chars, above the 1 MiB frame cap.
    await expect(
      ctx.artifacts.put({ buffer: Buffer.alloc(800_000), filename: "big.pdf", mime: "application/pdf" }),
    ).rejects.toThrow(/too large for a dev-mode frame/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("sends a put whose frame stays within the cap", async () => {
    const rpc = vi.fn().mockResolvedValue("artifact_ok");
    const { ctx } = createCtxProxy({ inline: inline(), rpc });
    // 700 000 raw bytes ⇒ ~933 336 base64 chars, plus envelope: under 1 MiB.
    await expect(
      ctx.artifacts.put({ buffer: Buffer.alloc(700_000), filename: "ok.pdf", mime: "application/pdf" }),
    ).resolves.toBe("artifact_ok");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
