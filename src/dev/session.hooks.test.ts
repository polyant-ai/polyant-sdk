// SPDX-License-Identifier: Apache-2.0

/**
 * The hook half of the dev session: what it declares, what it runs, and what it
 * sends back when a handler steers the turn.
 */

import { describe, expect, it, vi } from "vitest";
import { defineHook } from "../hooks.js";
import type { HookContext } from "../hooks.js";
import type { DevSessionEvent } from "./events.js";
import { FakeDevSocket } from "./fake-socket.test-fixture.js";
import { DEV_PROTOCOL_VERSION, type InlineHookContext } from "./protocol.js";
import type { DevHook } from "./load-hooks.js";
import { serveDevSession, toHookDeclarations, type DevSessionHandle } from "./session.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const inlineCtx = (over: Partial<InlineHookContext> = {}): InlineHookContext => ({
  instanceId: "acme-bot",
  conversationId: "telegram:42",
  instance: { slug: "acme-bot", flags: {} },
  secrets: { api_key: "s3cr3t" },
  state: { seen: 1 },
  ...over,
});

const payload = {
  instance: { slug: "acme-bot" },
  conversation: { id: "telegram:42" },
  channel: { type: "telegram", id: "42" },
  user: { name: "P" },
  message: { text: "hi" },
};

function guard(handler?: (ctx: HookContext) => unknown, route?: DevHook["route"]): DevHook {
  return {
    definition: defineHook({
      name: "guard",
      description: "guards the turn",
      requiredSecrets: ["api_key"],
      handler: (handler ?? (() => undefined)) as never,
    }),
    route: route ?? { bindTo: { event: "message_received" } },
  };
}

async function connect(opts: { hooks: readonly DevHook[]; events?: DevSessionEvent[] }): Promise<{
  handle: DevSessionHandle;
  socket: FakeDevSocket;
}> {
  const socket = new FakeDevSocket();
  const promise = serveDevSession({
    agentSlug: "acme-bot",
    token: "tok_live",
    url: "ws://engine.test",
    tools: [],
    hooks: opts.hooks,
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
    warnings: [],
  });
  return { handle: await promise, socket };
}

describe("toHookDeclarations", () => {
  it("puts the route on the wire, and normalizes a binding's defaults", () => {
    const [declaration] = toHookDeclarations([guard()]);
    expect(declaration).toMatchObject({
      name: "guard",
      requiredSecrets: ["api_key"],
      overrides: null,
      bindTo: { event: "message_received", position: 0, timeoutMs: 10_000 },
    });
  });

  it("declares a substitution by the canonical name it replaces", () => {
    // Unlike a tool, a hook is resolved by NAME and not equipped by collision,
    // so what it substitutes is something the client has to say.
    const [declaration] = toHookDeclarations([
      guard(undefined, { overrides: "dentalpro:greeting" }),
    ]);
    expect(declaration).toMatchObject({ overrides: "dentalpro:greeting", bindTo: null });
  });

  it("still declares a hook with no route", () => {
    // The engine warns that nothing will invoke it, which is a truer answer
    // than dropping it here in silence.
    const [declaration] = toHookDeclarations([{ definition: guard().definition }]);
    expect(declaration).toMatchObject({ overrides: null, bindTo: null });
  });
});

describe("serveDevSession — hooks", () => {
  it("declares its hooks in the handshake", async () => {
    const { handle, socket } = await connect({ hooks: [guard()] });
    const [hello] = socket.framesOf("hello");
    expect(hello.hooks).toMatchObject([{ name: "guard", bindTo: { event: "message_received" } }]);
    handle.close();
  });

  it("runs the local handler and returns its control over the turn", async () => {
    const events: DevSessionEvent[] = [];
    const handler = vi.fn().mockResolvedValue({ halt: { message: "not today" } });
    const { handle, socket } = await connect({ hooks: [guard(handler)], events });

    socket.deliver({
      type: "hook.invoke",
      callId: "c1",
      hook: "guard",
      event: "message_received",
      payload,
      ctx: inlineCtx(),
    });
    await tick();

    const [result] = socket.framesOf("hook.result");
    expect(result).toMatchObject({ callId: "c1", ok: true, control: { halt: { message: "not today" } } });
    expect(events.map((e) => e.type)).toContain("hook_result");
    handle.close();
  });

  it("gives the handler the inline context, with state readable and writes returned", async () => {
    let seen: unknown;
    const handler = vi.fn().mockImplementation((ctx: HookContext) => {
      seen = { state: ctx.state.get("seen"), secret: ctx.secrets.api_key, slug: ctx.instance.slug };
      ctx.state.set("flagged", true);
      ctx.audit.log({ action: "checked" });
      return undefined;
    });
    const { handle, socket } = await connect({ hooks: [guard(handler)] });

    socket.deliver({
      type: "hook.invoke", callId: "c1", hook: "guard", event: "message_received", payload, ctx: inlineCtx(),
    });
    await tick();

    expect(seen).toEqual({ state: 1, secret: "s3cr3t", slug: "acme-bot" });
    const [result] = socket.framesOf("hook.result");
    // Writes ride the result so the engine applies them only on success.
    expect(result).toMatchObject({
      stateWrites: [{ op: "set", key: "flagged", value: true }],
      auditEntries: [{ action: "checked" }],
    });
    handle.close();
  });

  it("reports a throwing handler as a failed hook, with no state writes", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("boom"));
    const { handle, socket } = await connect({ hooks: [guard(handler)] });

    socket.deliver({
      type: "hook.invoke", callId: "c1", hook: "guard", event: "message_received", payload, ctx: inlineCtx(),
    });
    await tick();

    expect(socket.framesOf("hook.result")[0]).toMatchObject({ ok: false, error: "boom", stateWrites: [] });
    handle.close();
  });

  it("answers a hook it does not serve with an error instead of silence", async () => {
    const { handle, socket } = await connect({ hooks: [guard()] });
    socket.deliver({
      type: "hook.invoke", callId: "c1", hook: "ghost", event: "message_received", payload, ctx: inlineCtx(),
    });
    await tick();
    expect(socket.framesOf("hook.result")[0]).toMatchObject({ ok: false });
    handle.close();
  });

  it("aborts the handler's signal and discards its late outcome", async () => {
    let aborted = false;
    const handler = vi.fn().mockImplementation(async (ctx: HookContext) => {
      ctx.abortSignal?.addEventListener("abort", () => void (aborted = true));
      await new Promise((r) => setTimeout(r, 5));
      return { halt: { message: "too late" } };
    });
    const { handle, socket } = await connect({ hooks: [guard(handler)] });

    socket.deliver({
      type: "hook.invoke", callId: "c1", hook: "guard", event: "message_received", payload, ctx: inlineCtx(),
    });
    await tick();
    socket.deliver({ type: "hook.abort", callId: "c1" });
    await new Promise((r) => setTimeout(r, 15));

    // The engine settled the call already: a late control return would steer a
    // turn that has moved on.
    expect(aborted).toBe(true);
    expect(socket.framesOf("hook.result")).toHaveLength(0);
    handle.close();
  });

  it("keeps serving the previous hooks when the engine rejects a reload", async () => {
    const events: DevSessionEvent[] = [];
    const { handle, socket } = await connect({ hooks: [guard()], events });

    handle.updateHooks([guard(undefined, { overrides: "dentalpro:greeting" })]);
    socket.deliver({ type: "hooks.update.result", ok: false, warnings: [], reason: "nope" });
    await tick();

    expect(events.map((e) => e.type)).toContain("hooks_update_rejected");
    // Still the bound declaration: a rejected update leaves the engine serving
    // the previous set, and this runtime must agree with it.
    expect(toHookDeclarations([guard()])[0].bindTo).not.toBeNull();
    handle.close();
  });

  it("adopts a reload the engine accepted", async () => {
    const events: DevSessionEvent[] = [];
    const { handle, socket } = await connect({ hooks: [guard()], events });

    handle.updateHooks([guard(undefined, { overrides: "dentalpro:greeting" })]);
    socket.deliver({ type: "hooks.update.result", ok: true, warnings: ["heads up"] });
    await tick();

    const updated = events.find((e) => e.type === "hooks_updated");
    expect(updated).toMatchObject({ hooks: ["guard"], warnings: ["heads up"] });
    handle.close();
  });
});
