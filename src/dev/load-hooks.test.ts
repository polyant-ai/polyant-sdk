// SPDX-License-Identifier: Apache-2.0

/**
 * Loading hook files from disk, and the mistakes that must not degrade into
 * "your hook silently never ran".
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHooksFromPaths, devHook, isHookDefinition } from "./load-hooks.js";

let dir = "";

const HOOK = (name: string, dev?: string) =>
  `export default { name: ${JSON.stringify(name)}, description: "d", requiredSecrets: [], handler: () => undefined };` +
  (dev ? `\nexport const dev = ${dev};` : "");

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sdk-hooks-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadHooksFromPaths", () => {
  it("loads a hook and its declared route", async () => {
    await writeFile(
      join(dir, "guard.hook.mjs"),
      HOOK("guard", `{ bindTo: { event: "message_received", position: 3 } }`),
    );
    const [loaded] = await loadHooksFromPaths([join(dir, "guard.hook.mjs")]);
    expect(loaded.definition.name).toBe("guard");
    expect(loaded.route).toEqual({ bindTo: { event: "message_received", position: 3 } });
  });

  it("loads a hook with no route at all", async () => {
    // Legitimate and inert: the engine says nothing will invoke it. Refusing
    // here would block the state a developer is in right after writing one.
    await writeFile(join(dir, "plain.hook.mjs"), HOOK("plain"));
    const [loaded] = await loadHooksFromPaths([join(dir, "plain.hook.mjs")]);
    expect(loaded.route).toBeUndefined();
  });

  it("refuses a file whose default export is not a hook", async () => {
    await writeFile(join(dir, "broken.hook.mjs"), `export default { name: "x" };`);
    await expect(loadHooksFromPaths([join(dir, "broken.hook.mjs")])).rejects.toThrow(
      /default export is not a hook definition/,
    );
  });

  it("refuses a route that declares both ways in", async () => {
    await writeFile(
      join(dir, "both.hook.mjs"),
      HOOK("both", `{ overrides: "plugin:fn", bindTo: { event: "message_received" } }`),
    );
    await expect(loadHooksFromPaths([join(dir, "both.hook.mjs")])).rejects.toThrow(/Pick one/);
  });

  it("refuses a route that declares neither", async () => {
    await writeFile(join(dir, "empty.hook.mjs"), HOOK("empty", `{}`));
    await expect(loadHooksFromPaths([join(dir, "empty.hook.mjs")])).rejects.toThrow(/neither/);
  });

  it("walks a directory and ignores files that are not hook files", async () => {
    // Its own directory: the refusal cases above leave broken files behind, and
    // a directory walk would pick them up.
    const sub = join(dir, "walk");
    await mkdir(sub);
    await writeFile(join(sub, "one.hook.mjs"), HOOK("one", `{ bindTo: { event: "response_sent" } }`));
    await writeFile(join(sub, "notes.md"), "# not a hook");
    const loaded = await loadHooksFromPaths([sub]);
    expect(loaded.map((h) => h.definition.name)).toEqual(["one"]);
  });
});

describe("devHook", () => {
  it("returns the route it was given, typed", () => {
    expect(devHook({ overrides: "plugin:fn" })).toEqual({ overrides: "plugin:fn" });
  });
});

describe("isHookDefinition", () => {
  it("accepts a definition and rejects a tool-shaped object", () => {
    expect(isHookDefinition({ name: "h", handler: () => undefined })).toBe(true);
    expect(isHookDefinition({ name: "t", execute: () => undefined })).toBe(false);
    expect(isHookDefinition(null)).toBe(false);
  });
});
