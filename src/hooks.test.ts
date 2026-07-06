// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { defineHook } from "./hooks.js";

describe("defineHook", () => {
  it("returns the definition unchanged (identity passthrough)", () => {
    const def = defineHook({
      name: "faq-gate",
      description: "d",
      handler: () => ({ halt: { message: "closed" } }),
    });
    expect(def.name).toBe("faq-gate");
    expect(typeof def.handler).toBe("function");
  });

  it("carries mutatesResponse + requiredSecrets", () => {
    const def = defineHook({
      name: "redactor",
      description: "d",
      mutatesResponse: true,
      requiredSecrets: ["redact_api_key"],
      handler: () => undefined,
    });
    expect(def.mutatesResponse).toBe(true);
    expect(def.requiredSecrets).toEqual(["redact_api_key"]);
  });

  it("a handler may return void / halt / replaceResponse / injectContext", async () => {
    const noop = defineHook({ name: "a", description: "d", handler: () => undefined });
    const replace = defineHook({ name: "b", description: "d", handler: async () => ({ replaceResponse: { message: "x" } }) });
    const inject = defineHook({ name: "c", description: "d", handler: () => ({ injectContext: "ctx" }) });
    expect(await noop.handler({} as never)).toBeUndefined();
    expect(await replace.handler({} as never)).toEqual({ replaceResponse: { message: "x" } });
    expect(await inject.handler({} as never)).toEqual({ injectContext: "ctx" });
  });
});
