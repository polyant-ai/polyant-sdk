// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { z as z3 } from "zod-v3";
import { defineTool, toJsonSchema, normalizeRequiredSecrets } from "./contract.js";
import type { ToolContext } from "./context-types.js";

const stubCtx = (over: Partial<ToolContext> = {}): ToolContext => ({
  instanceId: "inst" as ToolContext["instanceId"],
  audit: { log() {} },
  artifacts: { put: () => "artifact_stub", take: () => null },
  ...over,
});

describe("defineTool — serialized boundary", () => {
  const tool = defineTool({
    name: "demo",
    description: "d",
    category: "test",
    requiredSecrets: ["api_key", { key: "mode", type: "select", choices: ["a", "b"] }],
    parameters: z.object({ q: z.string(), n: z.number().nullable() }),
    execute: async (input, ctx) => `${input.q}:${ctx.instanceId}`,
  });

  it("serializes parameters to a plain JSON Schema (no live Zod instance)", () => {
    expect(tool.inputSchema.type).toBe("object");
    const props = tool.inputSchema.properties as Record<string, unknown>;
    expect(props.q).toBeDefined();
    expect(props.n).toBeDefined();
    // A plain data object, not a Zod schema.
    expect("_def" in (tool.inputSchema as object)).toBe(false);
    expect("safeParse" in (tool.inputSchema as object)).toBe(false);
    // $schema metadata is stripped.
    expect("$schema" in tool.inputSchema).toBe(false);
  });

  it("emits a strict-mode-friendly object schema (all keys required, bounded additionalProperties)", () => {
    const s = tool.inputSchema as { required?: string[]; additionalProperties?: unknown; properties?: object };
    expect(s.required).toEqual(expect.arrayContaining(["q", "n"]));
    // z.object → additionalProperties:false (OpenAI strict-mode).
    expect(s.additionalProperties).toBe(false);
  });

  it("normalizes requiredSecrets (string → text/masked, select → readable)", () => {
    expect(tool.requiredSecrets).toEqual([
      { key: "api_key", type: "text", sensitive: true },
      { key: "mode", type: "select", choices: ["a", "b"], sensitive: false },
    ]);
  });

  it("execute receives (input, ctx) — ctx is a parameter, not a closure", async () => {
    const out = await tool.execute({ q: "hi" }, stubCtx({ instanceId: "acme" as ToolContext["instanceId"] }));
    expect(out).toBe("hi:acme");
  });
});

describe("normalizeRequiredSecrets guards", () => {
  it("rejects empty string keys", () => {
    expect(() => normalizeRequiredSecrets([""], "t")).toThrow(/empty string/);
  });
  it("rejects select without choices", () => {
    expect(() => normalizeRequiredSecrets([{ key: "k", type: "select" }], "t")).toThrow(/requires non-empty 'choices'/);
  });
});

describe("toJsonSchema", () => {
  it("maps .nullable() to a null-inclusive type (strict-mode opcionality)", () => {
    const js = toJsonSchema(z.object({ x: z.string().nullable() })) as {
      properties: { x: { type?: unknown } };
    };
    // zod-to-json-schema emits either type: ["string","null"] or anyOf; accept either.
    const x = js.properties.x;
    const asString = JSON.stringify(x);
    expect(asString).toContain("null");
  });

  it("gives the same JSON for the same schema written in Zod 3 and in Zod 4", () => {
    // Zod 3's builder API matches Zod 4's for everything below, so one builder
    // takes either; the cast only quiets the two copies' unrelated types.
    const build = (zz: typeof z) =>
      zz.object({
        query: zz.string().min(1).describe("What to search"),
        limit: zz.number().int().min(1).max(50).default(10).describe("Max results"),
        offset: zz.number().int().min(1).nullable(),
        count: zz.number().int().positive().optional(),
        delta: zz.number().int(),
        ratio: zz.number(),
        mode: zz.enum(["a", "b"]).optional(),
        tags: zz.array(zz.string()).max(5).optional(),
        when: zz.string().datetime().optional(),
        email: zz.string().email().optional(),
        code: zz.string().regex(/^[A-Z]{3}$/).optional(),
        meta: zz.record(zz.string(), zz.unknown()).optional(),
        nested: zz.object({ x: zz.boolean() }).nullable(),
        either: zz.union([zz.string(), zz.number()]),
        lit: zz.literal("x"),
        strict: zz.object({ y: zz.string() }).strict(),
        loose: zz.object({ y: zz.string() }).passthrough(),
      });
    const fromZod4 = toJsonSchema(build(z));
    const fromZod3 = toJsonSchema(build(z3 as unknown as typeof z));
    expect(fromZod4).toEqual(fromZod3);
    expect(fromZod4).not.toHaveProperty("$schema");
  });

  it("carries requiredKnowledge through to the definition, absent when unset", () => {
    const withGrant = defineTool({
      name: "logQuestion",
      description: "Append the question to the FAQ log.",
      requiredKnowledge: "write",
      parameters: z.object({ q: z.string() }),
      execute: async () => ({}),
    });
    expect(withGrant.requiredKnowledge).toBe("write");

    const without = defineTool({
      name: "plain",
      description: "Needs no knowledge access.",
      parameters: z.object({ q: z.string() }),
      execute: async () => ({}),
    });
    expect(without.requiredKnowledge).toBeUndefined();
  });
});
