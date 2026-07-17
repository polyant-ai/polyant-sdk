// SPDX-License-Identifier: Apache-2.0

import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolContext } from "./context-types.js";

// ---------------------------------------------------------------------------
// requiredSecrets contract (moved verbatim from the engine registry — the
// normalization semantics are part of the public authoring surface).
// ---------------------------------------------------------------------------

export interface RequiredSecretSpec {
  key: string;
  type: "text" | "select";
  label?: string;
  description?: string;
  choices?: string[];
  optional?: boolean;
  /** Credential to mask (`true`) vs readable config value like a base URL (`false`).
   * After normalization always set: `text`→`true`, `select`→`false`, unless overridden. */
  sensitive?: boolean;
}

/** Either a bare string (`{ key, type: "text" }`) or a full spec. Mixed arrays allowed. */
export type RequiredSecretsInput = ReadonlyArray<string | RequiredSecretSpec>;

/**
 * Normalize a `RequiredSecretsInput` (mixed string + spec) into a uniform
 * `RequiredSecretSpec[]`. Throws on malformed specs so misconfiguration is
 * caught at load time, not at runtime.
 */
export function normalizeRequiredSecrets(
  input: RequiredSecretsInput | undefined,
  toolName?: string,
): RequiredSecretSpec[] {
  if (!input) return [];
  const prefix = toolName ? `Tool "${toolName}": ` : "";
  return input.map((entry, index) => {
    if (typeof entry === "string") {
      if (entry.length === 0) {
        throw new Error(
          `${prefix}requiredSecrets[${index}] is an empty string. Use a non-empty key (lowercase snake_case) or a full RequiredSecretSpec.`,
        );
      }
      return { key: entry, type: "text" as const, sensitive: true };
    }
    if (!entry.key) {
      throw new Error(`${prefix}requiredSecrets[${index}] missing 'key'.`);
    }
    if (entry.type === "select" && (!entry.choices || entry.choices.length === 0)) {
      throw new Error(
        `${prefix}requiredSecrets[${index}] "${entry.key}": type 'select' requires non-empty 'choices'.`,
      );
    }
    return { ...entry, sensitive: entry.sensitive ?? (entry.type === "select" ? false : true) };
  });
}

/** Extract just the secret key names from a normalized spec list. */
export function requiredSecretKeys(input: RequiredSecretsInput | undefined): string[] {
  return normalizeRequiredSecrets(input).map((s) => s.key);
}

/**
 * The requiredSecrets a tool must declare to use an OAuth `provider` via
 * `ctx.oauth`: the public client_id (readable) + the client_secret (masked; only
 * the engine's callback reads it, but declaring it here surfaces its Settings
 * slot). The key names are the broker contract shared with the engine:
 * `<provider>_oauth_client_id` / `<provider>_oauth_client_secret`.
 */
export function oauthRequiredSecrets(provider: string): RequiredSecretSpec[] {
  return [
    { key: `${provider}_oauth_client_id`, type: "text", sensitive: false, label: `${provider} OAuth client id` },
    { key: `${provider}_oauth_client_secret`, type: "text", sensitive: true, label: `${provider} OAuth client secret` },
  ];
}

// ---------------------------------------------------------------------------
// Tool contract
// ---------------------------------------------------------------------------

/** Illustrative input example shown to the LLM alongside the schema. */
export interface ToolInputExample {
  label: string;
  input: Record<string, unknown>;
}

/**
 * What a tool author passes to {@link defineTool}. The schema is authored in Zod
 * (ergonomic) but MUST be static — it may not depend on the runtime `ctx` (the
 * whole catalog already satisfies this). `defineTool` serializes it to JSON
 * Schema at module load, in the tool's own realm, so the engine never touches a
 * live Zod object across a package boundary.
 */
export interface ToolSpec {
  name: string;
  description: string;
  category?: string;
  /** Env vars that must be set for this tool to be available (pruned at load). */
  requiredEnv?: string[];
  /** Per-instance config fields (secrets / typed selects). */
  requiredSecrets?: RequiredSecretsInput;
  /** Harness tools are hidden from the admin UI; equipped only when the supervisor
   * runs with a matching `includeHarness` set. */
  harness?: boolean;
  /** Meta-tools are built specially by the supervisor (they need other built tools). */
  metaTool?: boolean;
  inputExamples?: ToolInputExample[];
  /** Static Zod schema for the tool's input. Serialized to JSON Schema at load. */
  parameters: z.ZodType;
  /** Business logic. Receives validated `input` and the runtime `ctx`. */
  execute: (input: any, ctx: ToolContext) => Promise<unknown>;
}

/**
 * The SERIALIZED tool definition the engine loader collects and stores. The
 * schema is a plain JSON Schema object (data, not a live Zod instance); `execute`
 * is a function the engine calls. Neither crosses the package boundary by
 * identity, so a plugin resolving its own copy of the SDK / Zod is harmless.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  category?: string;
  requiredEnv?: string[];
  requiredSecrets: RequiredSecretSpec[];
  harness?: boolean;
  metaTool?: boolean;
  inputExamples?: ToolInputExample[];
  /** JSON Schema (jsonSchema7) for the tool input. */
  inputSchema: Record<string, unknown>;
  execute: (input: any, ctx: ToolContext) => Promise<unknown>;
}

/** Serializable subset for the admin panel. */
export interface ToolInfo {
  name: string;
  description: string;
  category: string;
  requiredSecrets?: RequiredSecretSpec[];
  inputExamples?: ToolInputExample[];
}

/**
 * Convert a static Zod schema to a plain JSON Schema (jsonSchema7). `$refStrategy:
 * "none"` inlines everything (the AI SDK / OpenAI want a self-contained schema);
 * the `$schema` metadata key is stripped. Runs in the caller's realm using the
 * caller's Zod, so no cross-package `instanceof` is ever required downstream.
 */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = zodToJsonSchema(schema, { target: "jsonSchema7", $refStrategy: "none" }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  return json;
}

/**
 * Author a tool. Returned object is the plugin file's `export default`; the
 * engine's loader collects it. The Zod `parameters` are serialized to JSON Schema
 * here, at module load, so the engine consumes only data.
 */
export function defineTool(spec: ToolSpec): ToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    category: spec.category,
    requiredEnv: spec.requiredEnv,
    requiredSecrets: normalizeRequiredSecrets(spec.requiredSecrets, spec.name),
    harness: spec.harness,
    metaTool: spec.metaTool,
    inputExamples: spec.inputExamples,
    inputSchema: toJsonSchema(spec.parameters),
    execute: spec.execute,
  };
}
