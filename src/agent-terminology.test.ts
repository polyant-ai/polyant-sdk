// SPDX-License-Identifier: Apache-2.0

/**
 * Pins the 1.6.0 agent-terminology rename as ADDITIVE. The whole point of
 * shipping it as a minor is that a tool or hook authored against <= 1.5.0 keeps
 * compiling and keeps reading its old field, so these assertions guard the
 * deprecated aliases against a well-meaning cleanup that would silently turn the
 * next 1.x release into a breaking one.
 */

import { describe, it, expect, expectTypeOf } from "vitest";
import { defineTool } from "./contract.js";
import { defineHook } from "./hooks.js";
import type { AgentSlug, InstanceSlug, ToolContext } from "./context-types.js";
import type { HookContext, HookEventPayload } from "./hooks.js";
import { z } from "zod";

describe("1.6.0 agent terminology", () => {
  it("keeps InstanceSlug and AgentSlug the same type in both directions", () => {
    expectTypeOf<InstanceSlug>().toEqualTypeOf<AgentSlug>();

    // A value produced under the old name is accepted where the new name is
    // required, and vice versa — this is what lets a 1.5.0-built plugin run.
    const legacy = "acme" as InstanceSlug;
    const renamed: AgentSlug = legacy;
    const back: InstanceSlug = renamed;
    expect(back).toBe("acme");
  });

  it("exposes both agentId and instanceId on ToolContext", () => {
    expectTypeOf<ToolContext>().toHaveProperty("agentId");
    expectTypeOf<ToolContext>().toHaveProperty("instanceId");
    expectTypeOf<ToolContext["instanceId"]>().toEqualTypeOf<ToolContext["agentId"]>();
  });

  it("exposes both agent and instance on the hook context and payload", () => {
    expectTypeOf<HookContext>().toHaveProperty("agent");
    expectTypeOf<HookContext>().toHaveProperty("instance");
    expectTypeOf<HookEventPayload>().toHaveProperty("agent");
    expectTypeOf<HookEventPayload>().toHaveProperty("instance");
  });

  it("runs a tool that reads the deprecated ctx.instanceId", async () => {
    const tool = defineTool({
      name: "legacyReader",
      description: "reads the pre-1.6.0 field",
      parameters: z.object({}),
      execute: async (_input, ctx) => ctx.instanceId,
    });

    const ctx = {
      agentId: "acme" as AgentSlug,
      instanceId: "acme" as AgentSlug,
      audit: { log() {} },
    } satisfies ToolContext;

    expect(await tool.execute({}, ctx)).toBe("acme");
  });

  it("runs a tool that reads the new ctx.agentId", async () => {
    const tool = defineTool({
      name: "renamedReader",
      description: "reads the 1.6.0 field",
      parameters: z.object({}),
      execute: async (_input, ctx) => ctx.agentId,
    });

    const ctx = {
      agentId: "acme" as AgentSlug,
      instanceId: "acme" as AgentSlug,
      audit: { log() {} },
    } satisfies ToolContext;

    expect(await tool.execute({}, ctx)).toBe("acme");
  });

  it("accepts a hook declared against either field name", () => {
    const legacy = defineHook({
      name: "legacyHook",
      description: "reads payload.instance",
      handler: async (ctx) => {
        expect(ctx.payload.instance.slug).toBe(ctx.payload.agent.slug);
      },
    });

    expect(legacy.name).toBe("legacyHook");
  });
});
