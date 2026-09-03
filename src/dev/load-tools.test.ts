// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isToolDefinition, loadToolsFromPaths } from "./load-tools.js";

/** A tool file written as plain ESM: the loader's contract is the default
 *  export's SHAPE, not that it came from `defineTool` in this same realm. */
const toolFile = (name: string): string =>
  `export default { name: ${JSON.stringify(name)}, description: "d", ` +
  `inputSchema: { type: "object", properties: {}, additionalProperties: false }, ` +
  `requiredSecrets: [], execute: async () => ({ ok: ${JSON.stringify(name)} }) };\n`;

let root = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "polyant-dev-tools-"));
  // Everything the directory-scan test walks lives under `scan/`; the malformed
  // and the rewritten fixtures sit outside it so the scan is not about them.
  await mkdir(join(root, "scan", "nested"), { recursive: true });
  await mkdir(join(root, "scan", "node_modules", "pkg"), { recursive: true });
  await writeFile(join(root, "scan", "alpha.tool.mjs"), toolFile("alpha"));
  await writeFile(join(root, "scan", "notes.md"), "not a tool");
  await writeFile(join(root, "scan", "helper.mjs"), toolFile("helper"));
  await writeFile(join(root, "scan", "nested", "beta.tool.mjs"), toolFile("beta"));
  await writeFile(join(root, "scan", "node_modules", "pkg", "vendor.tool.mjs"), toolFile("vendor"));
  await writeFile(join(root, "broken.tool.mjs"), "export const notDefault = 1;\n");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("loadToolsFromPaths", () => {
  it("collects *.tool.* recursively, ignoring plain modules and node_modules", async () => {
    const tools = await loadToolsFromPaths([join(root, "scan")]);
    expect(tools.map((t) => t.name)).toEqual(["alpha", "beta"]);
  });

  it("accepts an explicit file path, and ignores one that is not a tool file", async () => {
    const tools = await loadToolsFromPaths([
      join(root, "scan", "alpha.tool.mjs"),
      join(root, "scan", "notes.md"),
    ]);
    expect(tools.map((t) => t.name)).toEqual(["alpha"]);
  });

  it("throws, naming the file, when the default export is not a tool", async () => {
    await expect(loadToolsFromPaths([join(root, "broken.tool.mjs")])).rejects.toThrow(
      /broken\.tool\.mjs: default export is not a tool definition/,
    );
  });

  it("re-imports a changed file only with cacheBust", async () => {
    const file = join(root, "mutable.tool.mjs");
    await writeFile(file, toolFile("v1"));
    expect((await loadToolsFromPaths([file])).map((t) => t.name)).toEqual(["v1"]);
    await writeFile(file, toolFile("v2"));
    expect((await loadToolsFromPaths([file])).map((t) => t.name)).toEqual(["v1"]); // module cache
    expect((await loadToolsFromPaths([file], { cacheBust: true })).map((t) => t.name)).toEqual(["v2"]);
  });
});

describe("isToolDefinition", () => {
  it("accepts the defineTool shape and rejects near-misses", () => {
    const valid = { name: "a", description: "d", inputSchema: {}, execute: async () => null };
    expect(isToolDefinition(valid)).toBe(true);
    expect(isToolDefinition({ ...valid, execute: "nope" })).toBe(false);
    expect(isToolDefinition({ ...valid, inputSchema: undefined })).toBe(false);
    expect(isToolDefinition(null)).toBe(false);
    expect(isToolDefinition(undefined)).toBe(false);
  });
});
