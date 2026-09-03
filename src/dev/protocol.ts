// SPDX-License-Identifier: Apache-2.0

/**
 * The dev-bridge wire contract, CLIENT side.
 *
 * This is a verbatim port of the engine's `dev-mode/dev-protocol.ts` — same
 * frames, same Zod schemas, same {@link DEV_PROTOCOL_VERSION} — relicensed
 * under this package's Apache-2.0 (same owner, public package).
 *
 * The only thing that differs from the engine copy is the DIRECTION of the two
 * helpers: the engine parses client frames and serializes server frames, this
 * side does the opposite. Both schemas are exported here anyway, because the
 * cheapest proof that this client speaks the server's protocol is to validate
 * the frames it produces against the very schema the server validates them
 * with.
 *
 * An incompatible change here requires bumping {@link DEV_PROTOCOL_VERSION} in
 * BOTH copies; the engine's handshake rejects a mismatch explicitly rather than
 * letting it surface three turns later as a frame that no longer validates.
 */

import { z } from "zod";

/** Bump ONLY on an incompatible change to the frames. */
export const DEV_PROTOCOL_VERSION = 1;

/**
 * Byte length of the JSON of an already-parsed value. Returns `Infinity`
 * (⇒ rejected) when it is not serializable: a cycle or a BigInt must not turn
 * the validation of a hostile frame into an exception.
 */
function serializedByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

// --- shared pieces ---------------------------------------------------------

/**
 * Cap on the serialized `inputSchema`, mirroring the engine's: the field is
 * unbounded by construction and arrives up to 200 times per frame BEFORE any
 * authentication. Enforced client-side too so an oversized schema is a local
 * error with a tool name attached, not an opaque socket close.
 */
const MAX_INPUT_SCHEMA_BYTES = 64 * 1024;

/** A tool declaration as it leaves the client: JSON Schema, never Zod. */
const devToolDeclarationSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(4096),
  /** JSON Schema serialized by `defineTool` inside the client's own realm. */
  inputSchema: z.record(z.string(), z.unknown()).refine(
    (schema) => serializedByteLength(schema) <= MAX_INPUT_SCHEMA_BYTES,
    { message: `inputSchema must serialize to at most ${MAX_INPUT_SCHEMA_BYTES} bytes` },
  ),
  requiredSecrets: z.array(z.string().min(1)).default([]),
  /** Canonical name of the tool this replaces, or null for a new tool. */
  overrides: z.string().min(1).nullable().default(null),
});

/** A state write, recorded by the local proxy and re-applied by the engine. */
const stateWriteSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set"), key: z.string().min(1), value: z.unknown() }),
  z.object({ op: z.literal("delete"), key: z.string().min(1) }),
]);

/** An audit entry produced by the local tool (`ctx.audit.log` is void). */
const auditEntrySchema = z.object({
  action: z.string().min(1).max(100),
  details: z.record(z.string(), z.unknown()).optional(),
  success: z.boolean().optional(),
  error: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  output: z.string().optional(),
});

/** The ctx ops that need a real round trip (already async in-process). */
export const CTX_OPS = [
  "conversation.getRecentMessages",
  "oauth.requireToken",
  "oauth.connectResult",
] as const;
export type CtxOp = (typeof CTX_OPS)[number];

// --- client → engine -------------------------------------------------------

export const clientFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocolVersion: z.number().int(),
    agentSlug: z.string().min(1).max(100),
    token: z.string().min(1).max(256),
    sdkVersion: z.string().min(1).max(32),
    tools: z.array(devToolDeclarationSchema).max(200),
  }),
  z.object({
    type: z.literal("tools.update"),
    tools: z.array(devToolDeclarationSchema).max(200),
  }),
  z.object({
    type: z.literal("tool.result"),
    callId: z.string().min(1),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().optional(),
    stateWrites: z.array(stateWriteSchema).default([]),
    auditEntries: z.array(auditEntrySchema).default([]),
  }),
  z.object({
    type: z.literal("ctx.request"),
    rpcId: z.string().min(1),
    callId: z.string().min(1),
    op: z.enum(CTX_OPS),
    args: z.array(z.unknown()).default([]),
  }),
  z.object({ type: z.literal("pong") }),
]);

export type ClientFrame = z.infer<typeof clientFrameSchema>;
export type DevToolDeclaration = z.infer<typeof devToolDeclarationSchema>;
export type StateWrite = z.infer<typeof stateWriteSchema>;
export type AuditEntryPayload = z.infer<typeof auditEntrySchema>;

// --- engine → client -------------------------------------------------------

/** The inline `ctx`: everything that needs no round trip. */
const inlineToolContextSchema = z.object({
  instanceId: z.string().min(1),
  conversationId: z.string().optional(),
  memoryScopeKey: z.string().optional(),
  provider: z.string().optional(),
  /** Already scoped to the `requiredSecrets` the tool declared. */
  secrets: z.record(z.string(), z.string()),
  apiKeys: z.record(z.string(), z.unknown()).optional(),
  /** State snapshot: local reads are served from here. */
  state: z.record(z.string(), z.unknown()),
  channel: z.record(z.string(), z.unknown()).optional(),
  attachments: z.array(z.unknown()).optional(),
});

export type InlineToolContext = z.infer<typeof inlineToolContextSchema>;

export const serverFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello.ok"),
    sessionId: z.string().min(1),
    engineVersion: z.string().min(1),
    protocolVersion: z.number().int(),
    warnings: z.array(z.string()),
  }),
  z.object({
    type: z.literal("hello.error"),
    reason: z.string().min(1),
  }),
  z.object({
    type: z.literal("tool.invoke"),
    callId: z.string().min(1),
    tool: z.string().min(1),
    input: z.unknown(),
    ctx: inlineToolContextSchema,
  }),
  z.object({
    type: z.literal("tool.abort"),
    callId: z.string().min(1),
  }),
  z.object({
    type: z.literal("ctx.response"),
    rpcId: z.string().min(1),
    ok: z.boolean(),
    value: z.unknown().optional(),
    error: z.string().optional(),
  }),
  z.object({ type: z.literal("ping") }),
]);

export type ServerFrame = z.infer<typeof serverFrameSchema>;

// --- parsing ---------------------------------------------------------------

/**
 * Parse an incoming server frame. NEVER throws: a malformed frame (or a future
 * protocol version) must become a reported session error, not an exception
 * escaping a socket listener.
 */
export function parseServerFrame(
  raw: string,
): { ok: true; frame: ServerFrame } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${(err as Error).message}` };
  }
  const parsed = serverFrameSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }
  return { ok: true, frame: parsed.data };
}

/** Serialize an outgoing client frame. */
export function serializeClientFrame(frame: ClientFrame): string {
  return JSON.stringify(frame);
}
