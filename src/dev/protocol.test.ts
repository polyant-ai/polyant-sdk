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

  it("exposes exactly the three RPC-class ctx ops", () => {
    expect([...CTX_OPS]).toEqual([
      "conversation.getRecentMessages",
      "oauth.requireToken",
      "oauth.connectResult",
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
});
