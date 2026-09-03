// SPDX-License-Identifier: Apache-2.0

/**
 * Collect local tool definitions from the filesystem.
 *
 * IMPORTANT: importing a `*.tool.ts` file requires the HOST PROCESS to be able
 * to load TypeScript — i.e. to have been started with `tsx` (`tsx watch dev.ts`)
 * or an equivalent loader. This module deliberately does not try to arrange
 * that: registering a loader is a decision about the whole process, and belongs
 * to whoever owns the entry point (the Polyant CLI does it). Without one, a
 * `.ts` path fails with Node's own "unknown file extension" error.
 */

import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolDefinition } from "../contract.js";

const TOOL_FILE = /\.tool\.(ts|mts|cts|js|mjs|cjs)$/;
const SKIPPED_DIRS = new Set(["node_modules", "dist", ".git"]);

export interface LoadToolsOptions {
  /**
   * Append a unique query to each import specifier so a changed file is really
   * re-read. Node's ESM module cache is keyed by URL and has no invalidation:
   * without this a reload returns the ORIGINAL module, and a hot reload that
   * silently serves stale code is worse than no hot reload. Costs one leaked
   * module registry entry per reload, which is why it is opt-in.
   */
  cacheBust?: boolean;
}

/**
 * Import every `*.tool.*` file reachable from `paths` (files or directories,
 * recursively) and return their `defineTool` default exports.
 *
 * Throws on a file whose default export is not a tool definition: a typo in an
 * export is exactly the mistake that must not degrade into "your tool silently
 * did not load".
 */
export async function loadToolsFromPaths(
  paths: readonly string[],
  opts: LoadToolsOptions = {},
): Promise<ToolDefinition[]> {
  const files: string[] = [];
  for (const path of paths) files.push(...(await collectToolFiles(resolve(path))));

  const tools: ToolDefinition[] = [];
  for (const file of files.sort()) {
    const specifier = pathToFileURL(file).href + (opts.cacheBust ? `?reload=${Date.now()}-${files.indexOf(file)}` : "");
    const mod = (await import(specifier)) as { default?: unknown };
    const tool = mod.default;
    if (!isToolDefinition(tool)) {
      throw new Error(
        `${file}: default export is not a tool definition. A tool file must ` +
          "`export default defineTool({ name, description, parameters, execute })`.",
      );
    }
    tools.push(tool);
  }
  return tools;
}

/** True for the shape `defineTool` returns — the loader's own recognition rule. */
export function isToolDefinition(value: unknown): value is ToolDefinition {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Partial<ToolDefinition>;
  return (
    typeof t.name === "string" &&
    typeof t.description === "string" &&
    typeof t.execute === "function" &&
    typeof t.inputSchema === "object" &&
    t.inputSchema !== null
  );
}

async function collectToolFiles(path: string): Promise<string[]> {
  const info = await stat(path);
  if (info.isFile()) return TOOL_FILE.test(path) ? [path] : [];
  const found: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      found.push(...(await collectToolFiles(join(path, entry.name))));
    } else if (entry.isFile() && TOOL_FILE.test(entry.name) && !entry.name.includes(".test.")) {
      found.push(join(path, entry.name));
    }
  }
  return found;
}
