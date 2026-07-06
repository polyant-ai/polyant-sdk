// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { defineHook } from "./hooks.js";

describe("defineHook", () => {
  it("returns the definition with the handler + flags carried through", () => {
    const def = defineHook({
      name: "faq-gate",
      description: "d",
      mutatesResponse: true,
      handler: () => ({ halt: { message: "closed" } }),
    });
    expect(def.name).toBe("faq-gate");
    expect(def.mutatesResponse).toBe(true);
    expect(typeof def.handler).toBe("function");
  });

  it("normalizes requiredSecrets at definition time (parity with defineTool)", () => {
    const def = defineHook({
      name: "redactor",
      description: "d",
      requiredSecrets: ["redact_api_key"],
      handler: () => undefined,
    });
    expect(def.requiredSecrets).toEqual([{ key: "redact_api_key", type: "text", sensitive: true }]);
  });

  it("throws at load on a malformed requiredSecrets spec", () => {
    expect(() => defineHook({ name: "x", description: "d", requiredSecrets: [""], handler: () => undefined })).toThrow();
    expect(() =>
      defineHook({ name: "x", description: "d", requiredSecrets: [{ key: "k", type: "select" }], handler: () => undefined }),
    ).toThrow(/choices/);
  });

  it("a handler may return void / halt / replaceResponse / injectContext", async () => {
    const noop = defineHook({ name: "a", description: "d", handler: () => undefined });
    const replace = defineHook({ name: "b", description: "d", mutatesResponse: true, handler: async () => ({ replaceResponse: { message: "x" } }) });
    const inject = defineHook({ name: "c", description: "d", handler: () => ({ injectContext: "ctx" }) });
    expect(await noop.handler({} as never)).toBeUndefined();
    expect(await replace.handler({} as never)).toEqual({ replaceResponse: { message: "x" } });
    expect(await inject.handler({} as never)).toEqual({ injectContext: "ctx" });
  });
});
