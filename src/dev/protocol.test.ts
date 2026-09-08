// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  CTX_OPS,
  DEV_PROTOCOL_VERSION,
  clientFrameSchema,
  parseServerFrame,
  serializeClientFrame,
  serverFrameSchema,
} from "./protocol.js";

describe("dev protocol (client port)", () => {
  it("declares version 1, matching the engine's DEV_PROTOCOL_VERSION", () => {
    // The engine rejects a mismatch at the handshake, so this constant IS the
    // compatibility contract between the two copies of this file.
    expect(DEV_PROTOCOL_VERSION).toBe(1);
  });

  it("exposes exactly the RPC-class ctx ops the engine implements", () => {
    // Closed list on purpose: the engine's `dev-ctx-bridge` switches on these
    // names, so an op added on one side only is a runtime error on a dev turn.
    expect([...CTX_OPS]).toEqual([
      "conversation.getRecentMessages",
      "oauth.requireToken",
      "oauth.connectResult",
      "knowledge.search",
      "knowledge.get",
      "knowledge.list",
      "knowledge.write",
      "knowledge.append",
      "knowledge.delete",
      "knowledge.reingest",
    ]);
  });

  it("defaults the optional collections of tool.result and a declaration", () => {
    const frame = clientFrameSchema.parse({ type: "tool.result", callId: "c1", ok: true });
    expect(frame).toMatchObject({ stateWrites: [], auditEntries: [] });

    const hello = clientFrameSchema.parse({
      type: "hello",
      protocolVersion: DEV_PROTOCOL_VERSION,
      agentSlug: "a",
      token: "t",
      sdkVersion: "1.0.0",
      tools: [{ name: "x", description: "d", inputSchema: { type: "object" } }],
    });
    expect(hello.type === "hello" && hello.tools[0]).toMatchObject({ requiredSecrets: [], overrides: null });
  });

  it("rejects an inputSchema above the 64KB cap", () => {
    const parsed = clientFrameSchema.safeParse({
      type: "tools.update",
      tools: [{ name: "big", description: "d", inputSchema: { blob: "x".repeat(70_000) } }],
    });
    expect(parsed.success).toBe(false);
  });

  it("round-trips a client frame through the server's schema", () => {
    const raw = serializeClientFrame({ type: "pong" });
    expect(clientFrameSchema.parse(JSON.parse(raw))).toEqual({ type: "pong" });
  });

  it("parses a server frame and never throws on garbage", () => {
    const ok = parseServerFrame(JSON.stringify({ type: "ping" }));
    expect(ok).toEqual({ ok: true, frame: { type: "ping" } });

    expect(parseServerFrame("not json").ok).toBe(false);
    expect(parseServerFrame(JSON.stringify({ type: "nope" })).ok).toBe(false);
    const missing = parseServerFrame(JSON.stringify({ type: "hello.ok", sessionId: "s" }));
    expect(missing.ok).toBe(false);
  });

  it("parses tools.update.result — ok with warnings, rejected with a reason", () => {
    const accepted = serverFrameSchema.safeParse({ type: "tools.update.result", ok: true, warnings: ["heads up"] });
    expect(accepted).toMatchObject({ success: true, data: { ok: true, warnings: ["heads up"] } });

    const rejected = serverFrameSchema.safeParse({
      type: "tools.update.result", ok: false, warnings: [], reason: "duplicate name after sanitization",
    });
    expect(rejected).toMatchObject({
      success: true,
      data: { ok: false, reason: "duplicate name after sanitization" },
    });

    // `warnings` has no default — the engine always sends it, empty or not.
    expect(serverFrameSchema.safeParse({ type: "tools.update.result", ok: true }).success).toBe(false);
  });

  it("requires the inline ctx to carry instanceId, secrets and a state snapshot", () => {
    const invoke = {
      type: "tool.invoke", callId: "c", tool: "t", input: {},
      ctx: { instanceId: "a", secrets: {}, state: {} },
    };
    expect(serverFrameSchema.safeParse(invoke).success).toBe(true);
    expect(
      serverFrameSchema.safeParse({ ...invoke, ctx: { instanceId: "a", secrets: {} } }).success,
    ).toBe(false);
  });

  it("carries the knowledge grant inline, and treats its absence as no access", () => {
    const base = { type: "tool.invoke", callId: "c", tool: "t", input: {} };
    const granted = serverFrameSchema.safeParse({
      ...base,
      ctx: { instanceId: "a", secrets: {}, state: {}, knowledgeLevel: "write" },
    });
    expect(granted.success && granted.data.type === "tool.invoke" && granted.data.ctx.knowledgeLevel)
      .toBe("write");

    // An engine that grants nothing simply omits the field (as does an older
    // engine that knows no knowledge ops at all) — never a "none" sentinel.
    const ungranted = serverFrameSchema.safeParse({
      ...base,
      ctx: { instanceId: "a", secrets: {}, state: {} },
    });
    expect(ungranted.success && ungranted.data.type === "tool.invoke" && ungranted.data.ctx.knowledgeLevel)
      .toBeUndefined();

    expect(
      serverFrameSchema.safeParse({
        ...base,
        ctx: { instanceId: "a", secrets: {}, state: {}, knowledgeLevel: "none" },
      }).success,
    ).toBe(false);
  });
});
