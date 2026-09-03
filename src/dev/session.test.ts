// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineTool } from "../contract.js";
import type { ToolDefinition } from "../contract.js";
import type { DevToolContext } from "./ctx-proxy.js";
import type { DevSessionEvent } from "./events.js";
import { FakeDevSocket } from "./fake-socket.test-fixture.js";
import { DEV_PROTOCOL_VERSION, type InlineToolContext } from "./protocol.js";
import { serveDevSession, type DevSessionHandle } from "./session.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const inlineCtx = (over: Partial<InlineToolContext> = {}): InlineToolContext => ({
  instanceId: "acme-bot",
  conversationId: "telegram:42",
  secrets: { api_key: "s3cr3t" },
  state: { seen: 1 },
  ...over,
});

function echoTool(execute?: ToolDefinition["execute"]): ToolDefinition {
  return defineTool({
    name: "echo",
    description: "echoes its input",
    parameters: z.object({ text: z.string() }),
    requiredSecrets: ["api_key"],
    execute: execute ?? (async (input: unknown) => ({ echoed: input })),
  });
}

/** Connects a runtime against a fake socket, up to a successful handshake. */
async function connect(opts: {
  tools: readonly ToolDefinition[];
  events?: DevSessionEvent[];
  sockets?: FakeDevSocket[];
}): Promise<{ handle: DevSessionHandle; socket: FakeDevSocket }> {
  const socket = new FakeDevSocket();
  opts.sockets?.push(socket);
  const promise = serveDevSession({
    agentSlug: "acme-bot",
    token: "tok_live",
    url: "ws://engine.test",
    tools: opts.tools,
    webSocketImpl: () => socket,
    onEvent: (e) => opts.events?.push(e),
  });
  await tick();
  socket.open();
  await tick();
  socket.deliver({
    type: "hello.ok",
    sessionId: "sess-1",
    engineVersion: "1.2.3",
    protocolVersion: DEV_PROTOCOL_VERSION,
    warnings: ["tool \"echo\": heads up"],
  });
  return { handle: await promise, socket };
}

describe("serveDevSession — handshake", () => {
  it("sends a hello the engine's own schema accepts, then reports the session", async () => {
    const events: DevSessionEvent[] = [];
    const { handle, socket } = await connect({ tools: [echoTool()], events });

    const [hello] = socket.framesOf("hello");
    expect(hello).toMatchObject({
      protocolVersion: DEV_PROTOCOL_VERSION,
      agentSlug: "acme-bot",
      token: "tok_live",
      tools: [{ name: "echo", requiredSecrets: ["api_key"], overrides: null }],
    });
    expect(hello.tools[0].inputSchema).toMatchObject({ type: "object" });

    expect(handle.sessionId).toBe("sess-1");
    expect(handle.engineVersion).toBe("1.2.3");
    expect(handle.warnings).toEqual(['tool "echo": heads up']);
    expect(handle.connected).toBe(true);
    expect(events.map((e) => e.type)).toEqual(["connecting", "connected"]);
    handle.close();
  });

  it("rejects on hello.error and never retries it", async () => {
    const events: DevSessionEvent[] = [];
    const socket = new FakeDevSocket();
    const promise = serveDevSession({
      agentSlug: "acme-bot",
      token: "bad",
      url: "ws://engine.test",
      tools: [echoTool()],
      webSocketImpl: () => socket,
      onEvent: (e) => events.push(e),
      reconnect: { initialDelayMs: 1 },
    });
    await tick();
    socket.open();
    await tick();
    socket.deliver({ type: "hello.error", reason: "dev session unavailable for this agent" });

    await expect(promise).rejects.toThrow(/dev handshake rejected: dev session unavailable/);
    await new Promise((r) => setTimeout(r, 20));
    expect(events.filter((e) => e.type === "connecting")).toHaveLength(1);
    expect(events.some((e) => e.type === "handshake_rejected")).toBe(true);
  });

  it("refuses two tools with the same name before opening a socket", async () => {
    const factory = vi.fn(() => new FakeDevSocket());
    await expect(
      serveDevSession({
        agentSlug: "a",
        token: "t",
        tools: [echoTool(), echoTool()],
        webSocketImpl: factory,
      }),
    ).rejects.toThrow(/duplicate tool name "echo"/);
    expect(factory).not.toHaveBeenCalled();
  });
});

describe("serveDevSession — invocation", () => {
  it("runs the tool and returns state writes and audit entries with the result", async () => {
    const tool = echoTool(async (input: { text: string }, ctx: DevToolContext) => {
      expect(ctx.instanceId).toBe("acme-bot");
      expect(ctx.secrets?.api_key).toBe("s3cr3t");
      // SYNCHRONOUS state: read from the snapshot, then read back own write.
      expect(ctx.state?.get("seen")).toBe(1);
      ctx.state?.set("seen", 2);
      expect(ctx.state?.get("seen")).toBe(2);
      ctx.state?.delete("stale");
      ctx.audit.log({ action: "echoed", success: true });
      return { echoed: input.text };
    });
    const { handle, socket } = await connect({ tools: [tool] });

    socket.deliver({ type: "tool.invoke", callId: "c1", tool: "echo", input: { text: "hi" }, ctx: inlineCtx() });
    await tick();

    const [result] = socket.framesOf("tool.result");
    expect(result).toEqual({
      type: "tool.result",
      callId: "c1",
      ok: true,
      result: { echoed: "hi" },
      error: undefined,
      stateWrites: [
        { op: "set", key: "seen", value: 2 },
        { op: "delete", key: "stale" },
      ],
      auditEntries: [{ action: "echoed", success: true }],
    });
    handle.close();
  });

  it("returns a thrown tool error as a result, with no state writes", async () => {
    const tool = echoTool(async (_input: unknown, ctx: DevToolContext) => {
      ctx.state?.set("half", "written");
      throw new Error("boom");
    });
    const events: DevSessionEvent[] = [];
    const { handle, socket } = await connect({ tools: [tool], events });

    socket.deliver({ type: "tool.invoke", callId: "c2", tool: "echo", input: {}, ctx: inlineCtx() });
    await tick();

    const [result] = socket.framesOf("tool.result");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("boom");
    expect(result.stateWrites).toEqual([]);
    expect(events.find((e) => e.type === "result")).toMatchObject({ ok: false, error: "boom" });
    handle.close();
  });

  it("answers an invocation of an unserved tool with an error result", async () => {
    const { handle, socket } = await connect({ tools: [echoTool()] });
    socket.deliver({ type: "tool.invoke", callId: "c3", tool: "ghost", input: {}, ctx: inlineCtx() });
    await tick();
    expect(socket.framesOf("tool.result")[0]).toMatchObject({
      callId: "c3",
      ok: false,
      error: 'tool "ghost" is not served by this dev session',
    });
    handle.close();
  });
});

describe("serveDevSession — ctx RPC", () => {
  it("correlates a conversation read to the in-flight callId and resolves it", async () => {
    let seen: unknown;
    const tool = echoTool(async (_input: unknown, ctx: DevToolContext) => {
      seen = await ctx.conversation?.getRecentMessages(2, { roles: ["user"] });
      return { ok: true };
    });
    const events: DevSessionEvent[] = [];
    const { handle, socket } = await connect({ tools: [tool], events });

    socket.deliver({ type: "tool.invoke", callId: "c4", tool: "echo", input: {}, ctx: inlineCtx() });
    await tick();

    const [request] = socket.framesOf("ctx.request");
    expect(request).toMatchObject({
      callId: "c4",
      op: "conversation.getRecentMessages",
      args: [2, { roles: ["user"] }],
    });
    expect(socket.framesOf("tool.result")).toHaveLength(0); // still waiting on the RPC

    socket.deliver({
      type: "ctx.response",
      rpcId: request.rpcId,
      ok: true,
      value: [{ role: "user", content: "ciao" }],
    });
    await tick();

    expect(seen).toEqual([{ role: "user", content: "ciao" }]);
    expect(socket.framesOf("tool.result")[0]).toMatchObject({ callId: "c4", ok: true });
    expect(events.find((e) => e.type === "ctx_request")).toMatchObject({ callId: "c4" });
    handle.close();
  });

  it("surfaces a failed ctx op to the tool as a rejection", async () => {
    let message = "";
    const tool = echoTool(async (_input: unknown, ctx: DevToolContext) => {
      try {
        await ctx.oauth?.requireToken("google");
      } catch (err) {
        message = (err as Error).message;
      }
      return { done: true };
    });
    const { handle, socket } = await connect({ tools: [tool] });

    socket.deliver({ type: "tool.invoke", callId: "c5", tool: "echo", input: {}, ctx: inlineCtx() });
    await tick();
    const [request] = socket.framesOf("ctx.request");
    socket.deliver({ type: "ctx.response", rpcId: request.rpcId, ok: false, error: "ctx.oauth is not available" });
    await tick();

    expect(message).toBe("ctx.oauth is not available");
    expect(socket.framesOf("tool.result")[0]).toMatchObject({ ok: true });
    handle.close();
  });
});

describe("serveDevSession — abort, ping, reconnection", () => {
  it("discards the result of an aborted call and rejects its pending ctx ops", async () => {
    let release = (): void => {};
    let rpcError = "";
    const tool = echoTool(async (_input: unknown, ctx: DevToolContext) => {
      const pending = ctx.conversation?.getRecentMessages(1).catch((err: Error) => {
        rpcError = err.message;
      });
      await new Promise<void>((r) => {
        release = r;
      });
      await pending;
      return { late: true };
    });
    const events: DevSessionEvent[] = [];
    const { handle, socket } = await connect({ tools: [tool], events });

    socket.deliver({ type: "tool.invoke", callId: "c6", tool: "echo", input: {}, ctx: inlineCtx() });
    await tick();
    socket.deliver({ type: "tool.abort", callId: "c6" });
    release();
    await tick();

    expect(socket.framesOf("tool.result")).toHaveLength(0);
    expect(rpcError).toBe("call aborted by the engine");
    expect(events.find((e) => e.type === "aborted")).toMatchObject({ callId: "c6", tool: "echo" });
    handle.close();
  });

  it("answers a ping with a pong", async () => {
    const { handle, socket } = await connect({ tools: [echoTool()] });
    socket.deliver({ type: "ping" });
    await tick();
    expect(socket.framesOf("pong")).toHaveLength(1);
    handle.close();
  });

  it("re-handshakes after a drop, re-declaring the current tool set", async () => {
    const sockets: FakeDevSocket[] = [];
    const events: DevSessionEvent[] = [];
    const promise = serveDevSession({
      agentSlug: "acme-bot",
      token: "tok_live",
      url: "ws://engine.test",
      tools: [echoTool()],
      reconnect: { initialDelayMs: 1 },
      webSocketImpl: () => {
        const next = new FakeDevSocket();
        sockets.push(next);
        return next;
      },
      onEvent: (e) => events.push(e),
    });
    await tick();
    const first = sockets[0];
    first.open();
    await tick();
    first.deliver({
      type: "hello.ok", sessionId: "s1", engineVersion: "1.0.0",
      protocolVersion: DEV_PROTOCOL_VERSION, warnings: [],
    });
    const handle = await promise;

    first.close(1006, "engine restarted");
    expect(handle.connected).toBe(false);
    expect(events.find((e) => e.type === "disconnected")).toMatchObject({
      reason: "engine restarted", willReconnect: true,
    });

    await new Promise((r) => setTimeout(r, 20));
    const second = sockets[1];
    expect(second).toBeDefined();
    second.open();
    await tick();
    expect(second.framesOf("hello")[0]).toMatchObject({ agentSlug: "acme-bot", tools: [{ name: "echo" }] });
    second.deliver({
      type: "hello.ok", sessionId: "s2", engineVersion: "1.0.0",
      protocolVersion: DEV_PROTOCOL_VERSION, warnings: [],
    });
    await tick();
    expect(handle.sessionId).toBe("s2");
    expect(handle.connected).toBe(true);
    handle.close();
  });

  it("keeps the event loop alive while a reconnection is pending, until close()", async () => {
    // The observable property, asserted on the timer's `ref` rather than on
    // elapsed time: an unref'd timer here let a process whose only job is
    // serving the session exit 0 the moment it announced `willReconnect`.
    const created: ReturnType<typeof setTimeout>[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((fn: () => void, ms?: number) => {
        const timer = realSetTimeout(fn, ms);
        created.push(timer);
        return timer;
      }) as unknown as typeof setTimeout);

    try {
      const sockets: FakeDevSocket[] = [];
      const promise = serveDevSession({
        agentSlug: "acme-bot",
        token: "tok_live",
        url: "ws://engine.test",
        tools: [echoTool()],
        // Long enough that the timer is still pending when we look at it, so
        // the test never waits on it and can never hang on it.
        reconnect: { initialDelayMs: 60_000 },
        webSocketImpl: () => {
          const next = new FakeDevSocket();
          sockets.push(next);
          return next;
        },
      });
      await new Promise((r) => realSetTimeout(r, 0));
      sockets[0].open();
      await new Promise((r) => realSetTimeout(r, 0));
      sockets[0].deliver({
        type: "hello.ok", sessionId: "s1", engineVersion: "1.0.0",
        protocolVersion: DEV_PROTOCOL_VERSION, warnings: [],
      });
      const handle = await promise;

      created.length = 0;
      sockets[0].close(1006, "engine restarted");

      // The reconnection timer is the last one armed by the drop, and it holds
      // the loop: `hasRef()` is Node's own answer to "would this keep the
      // process alive?".
      const reconnectTimer = created.at(-1);
      expect(reconnectTimer).toBeDefined();
      expect(typeof reconnectTimer?.hasRef).toBe("function");
      expect(reconnectTimer?.hasRef()).toBe(true);

      // ...and closing the session is what gives the loop back.
      handle.close();
      expect(sockets).toHaveLength(1); // no reconnection was attempted after close
    } finally {
      spy.mockRestore();
    }
  });

  it("arms no reconnection timer at all when reconnect is disabled", async () => {
    const created: ReturnType<typeof setTimeout>[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((fn: () => void, ms?: number) => {
        const timer = realSetTimeout(fn, ms);
        created.push(timer);
        return timer;
      }) as unknown as typeof setTimeout);

    try {
      const socket = new FakeDevSocket();
      const promise = serveDevSession({
        agentSlug: "a", token: "t", url: "ws://engine.test", tools: [echoTool()],
        reconnect: false, webSocketImpl: () => socket,
      });
      await new Promise((r) => realSetTimeout(r, 0));
      socket.open();
      await new Promise((r) => realSetTimeout(r, 0));
      socket.deliver({
        type: "hello.ok", sessionId: "s1", engineVersion: "1.0.0",
        protocolVersion: DEV_PROTOCOL_VERSION, warnings: [],
      });
      const handle = await promise;

      created.length = 0;
      socket.close(1006, "gone");
      // `reconnect: false` is the documented way out for an embedder that must
      // not be held alive: nothing is armed, so there is nothing to unref.
      expect(created).toHaveLength(0);
      handle.close();
    } finally {
      spy.mockRestore();
    }
  });

  it("does not reconnect when reconnect is disabled, and close() is idempotent", async () => {
    const events: DevSessionEvent[] = [];
    const socket = new FakeDevSocket();
    const promise = serveDevSession({
      agentSlug: "a", token: "t", url: "ws://engine.test", tools: [echoTool()],
      reconnect: false, webSocketImpl: () => socket, onEvent: (e) => events.push(e),
    });
    await tick();
    socket.open();
    await tick();
    socket.deliver({
      type: "hello.ok", sessionId: "s1", engineVersion: "1.0.0",
      protocolVersion: DEV_PROTOCOL_VERSION, warnings: [],
    });
    const handle = await promise;
    socket.close(1006, "gone");
    expect(events.find((e) => e.type === "disconnected")).toMatchObject({ willReconnect: false });
    handle.close();
    handle.close();
    expect(events.filter((e) => e.type === "closed")).toHaveLength(1);
  });
});

describe("serveDevSession — hot reload", () => {
  it("sends tools.update and serves the new set", async () => {
    const events: DevSessionEvent[] = [];
    const { handle, socket } = await connect({ tools: [echoTool()], events });

    const replacement = defineTool({
      name: "echo",
      description: "echoes, louder",
      parameters: z.object({ text: z.string() }),
      execute: async (input: { text: string }) => ({ echoed: input.text.toUpperCase() }),
    });
    handle.updateTools([replacement]);

    expect(socket.framesOf("tools.update")[0]).toMatchObject({
      tools: [{ name: "echo", description: "echoes, louder", requiredSecrets: [] }],
    });
    socket.deliver({ type: "tool.invoke", callId: "c7", tool: "echo", input: { text: "hi" }, ctx: inlineCtx() });
    await tick();
    expect(socket.framesOf("tool.result")[0]).toMatchObject({ result: { echoed: "HI" } });
    expect(events.find((e) => e.type === "tools_updated")).toMatchObject({ tools: ["echo"] });
    handle.close();
  });
});
