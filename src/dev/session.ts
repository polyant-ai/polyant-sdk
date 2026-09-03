// SPDX-License-Identifier: Apache-2.0

/**
 * The dev-session client runtime: connects to an engine's dev bridge, declares
 * the local tools, and serves `tool.invoke` frames by running their real
 * `execute` against a proxied {@link ToolContext}.
 *
 * Everything the engine documents as its side of the contract is honoured here:
 * `hello` first, `pong` for every `ping`, `stateWrites`/`auditEntries` returned
 * WITH the result (so the engine applies them only on success), ctx RPCs
 * correlated by the in-flight `callId`, and a refused handshake never retried.
 */

import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "../contract.js";
import { requiredSecretKeys } from "../contract.js";
import { createCtxProxy } from "./ctx-proxy.js";
import type { DevSessionEvent, DevSessionEventHandler } from "./events.js";
import {
  DEV_PROTOCOL_VERSION,
  serializeClientFrame,
  parseServerFrame,
  type ClientFrame,
  type CtxOp,
  type DevToolDeclaration,
  type ServerFrame,
} from "./protocol.js";
import { SDK_VERSION } from "./sdk-version.js";
import { defaultWebSocketFactory, type DevWebSocketFactory, type DevWebSocketLike } from "./websocket.js";

/** The engine's WebSocket path. */
export const DEV_SOCKET_PATH = "/dev-mode/socket";

/** Used when `url` is omitted: the engine's default local address. */
export const DEFAULT_DEV_SOCKET_URL = `ws://localhost:4000${DEV_SOCKET_PATH}`;

/** Reconnection policy. `false` disables it: one connection, then done. */
export interface DevReconnectOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Backoff multiplier per attempt (default 2). */
  factor?: number;
}

export interface ServeDevSessionOptions {
  /** The agent (`instances.slug`) whose turns should equip these tools. */
  agentSlug: string;
  /** A dev token issued for that agent. Never logged by this runtime. */
  token: string;
  /** Full socket URL, or a base URL whose path is filled in with {@link DEV_SOCKET_PATH}. */
  url?: string;
  tools: readonly ToolDefinition[];
  webSocketImpl?: DevWebSocketFactory;
  onEvent?: DevSessionEventHandler;
  reconnect?: false | DevReconnectOptions;
  /**
   * Treat the connection as dead when no frame arrives for this long. The engine
   * pings every 20s, so the default (60s) is three missed ticks — needed because
   * a TCP connection dropped without a FIN never emits `close`.
   */
  staleAfterMs?: number;
  /** Overrides the reported SDK version. For tests; not for production use. */
  sdkVersion?: string;
}

export interface DevSessionHandle {
  /** Session id from the most recent successful handshake. */
  readonly sessionId: string;
  readonly agentSlug: string;
  /** Declaration warnings from the most recent handshake (strict-mode lint et al.). */
  readonly warnings: readonly string[];
  readonly engineVersion: string;
  readonly connected: boolean;
  /** Replace the served set and tell the engine (`tools.update`) — hot reload. */
  updateTools(tools: readonly ToolDefinition[]): void;
  /** Stop serving and close the socket. Idempotent. */
  close(reason?: string): void;
}

/**
 * A tool declaration as it goes on the wire. `overrides` is always `null`:
 * substitution is decided by the engine on NAME COLLISION, never on this field,
 * so declaring it here could only produce a handshake warning telling you to
 * rename the tool. Rename the tool.
 */
export function toDeclarations(tools: readonly ToolDefinition[]): DevToolDeclaration[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    requiredSecrets: requiredSecretKeys(tool.requiredSecrets),
    overrides: null,
  }));
}

/**
 * Open a dev session and serve the given tools until closed.
 *
 * Resolves once the engine has answered `hello.ok`. Rejects when the FIRST
 * handshake fails — a refused token or an unreachable engine is a thing to
 * report, not to retry behind the caller's back. Once established, a dropped
 * connection is retried with backoff (unless `reconnect: false`), while an
 * explicit `hello.error` on a retry stops the runtime for good.
 */
export async function serveDevSession(opts: ServeDevSessionOptions): Promise<DevSessionHandle> {
  const runtime = new DevSessionRuntime(opts);
  await runtime.start();
  return runtime;
}

interface InFlightCall {
  readonly tool: string;
  aborted: boolean;
  /** Outstanding ctx RPCs for this call, rejected when it ends. */
  readonly rpcIds: Set<string>;
}

interface PendingRpc {
  resolve(value: unknown): void;
  reject(err: Error): void;
}

const DEFAULT_RECONNECT: Required<DevReconnectOptions> = {
  initialDelayMs: 500,
  maxDelayMs: 15_000,
  factor: 2,
};

class DevSessionRuntime implements DevSessionHandle {
  sessionId = "";
  engineVersion = "";
  warnings: readonly string[] = [];

  readonly agentSlug: string;
  private readonly token: string;
  private readonly url: string;
  private readonly factory: DevWebSocketFactory;
  private readonly onEvent?: DevSessionEventHandler;
  private readonly reconnect: Required<DevReconnectOptions> | null;
  private readonly staleAfterMs: number;
  private readonly sdkVersion: string;

  private tools: Map<string, ToolDefinition>;
  private declarations: DevToolDeclaration[];

  private socket: DevWebSocketLike | null = null;
  private handshaken = false;
  private stopped = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly inFlight = new Map<string, InFlightCall>();
  private readonly pendingRpcs = new Map<string, PendingRpc>();

  constructor(opts: ServeDevSessionOptions) {
    this.agentSlug = opts.agentSlug;
    this.token = opts.token;
    this.url = resolveSocketUrl(opts.url);
    this.factory = opts.webSocketImpl ?? defaultWebSocketFactory();
    this.onEvent = opts.onEvent;
    this.reconnect = opts.reconnect === false ? null : { ...DEFAULT_RECONNECT, ...(opts.reconnect ?? {}) };
    this.staleAfterMs = opts.staleAfterMs ?? 60_000;
    this.sdkVersion = opts.sdkVersion ?? SDK_VERSION;
    this.tools = indexTools(opts.tools);
    this.declarations = toDeclarations(opts.tools);
  }

  get connected(): boolean {
    return this.handshaken && this.socket?.readyState === 1;
  }

  // --- lifecycle -----------------------------------------------------------

  /** First connection. Its failure is the caller's failure. */
  async start(): Promise<void> {
    await this.connectOnce();
  }

  updateTools(tools: readonly ToolDefinition[]): void {
    this.tools = indexTools(tools);
    this.declarations = toDeclarations(tools);
    this.emit({ type: "tools_updated", tools: [...this.tools.keys()] });
    if (this.connected) this.send({ type: "tools.update", tools: this.declarations });
  }

  close(reason = "closed by the local runtime"): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimers();
    this.failAllPendingRpcs(`dev session closed: ${reason}`);
    this.inFlight.clear();
    this.handshaken = false;
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close(1000, reason.slice(0, 100));
    } catch {
      /* already closed */
    }
    this.emit({ type: "closed", reason });
  }

  private connectOnce(): Promise<void> {
    this.attempt += 1;
    this.emit({ type: "connecting", url: this.url, attempt: this.attempt });

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settleOk = () => {
        if (settled) return;
        settled = true;
        this.attempt = 0;
        resolve();
      };
      const settleErr = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      let socket: DevWebSocketLike;
      try {
        socket = this.factory(this.url);
      } catch (err) {
        settleErr(new Error(`could not open ${this.url}: ${errMsg(err)}`));
        return;
      }
      this.socket = socket;
      this.handshaken = false;

      socket.addEventListener("open", () => {
        this.send({
          type: "hello",
          protocolVersion: DEV_PROTOCOL_VERSION,
          agentSlug: this.agentSlug,
          token: this.token,
          sdkVersion: this.sdkVersion,
          tools: this.declarations,
        });
        this.armStaleTimer();
      });

      socket.addEventListener("message", (event) => {
        this.armStaleTimer();
        this.onRaw(String(event.data ?? ""), settleOk, settleErr);
      });

      socket.addEventListener("error", (event) => {
        const message = typeof event.message === "string" ? event.message : "socket error";
        this.emit({ type: "error", message });
        settleErr(new Error(`could not connect to ${this.url}: ${message}`));
      });

      socket.addEventListener("close", (event) => {
        if (socket !== this.socket) return; // a socket we already replaced
        this.socket = null;
        const wasHandshaken = this.handshaken;
        this.handshaken = false;
        this.clearTimers();
        const reason = event.reason || "connection closed";
        this.failAllPendingRpcs(`dev session disconnected: ${reason}`);
        this.inFlight.clear();
        if (this.stopped) return;
        if (!wasHandshaken) {
          // Closed before `hello.ok`: either the engine refused us (already
          // reported, and `stopped` by then) or the socket died mid-handshake.
          settleErr(new Error(`dev session closed before the handshake completed: ${reason}`));
          return;
        }
        const retryInMs = this.reconnect ? this.nextDelay() : undefined;
        this.emit({
          type: "disconnected",
          code: event.code,
          reason,
          willReconnect: retryInMs !== undefined,
          retryInMs,
        });
        if (retryInMs !== undefined) this.scheduleReconnect(retryInMs);
      });
    });
  }

  private nextDelay(): number {
    const policy = this.reconnect;
    if (!policy) return 0;
    const raw = policy.initialDelayMs * policy.factor ** Math.max(0, this.attempt);
    return Math.min(policy.maxDelayMs, raw);
  }

  private scheduleReconnect(delayMs: number): void {
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      // A reconnection failure is not the caller's to await any more: it is
      // reported as an event and retried, so the session survives an engine
      // restart without the wrapper having to re-run anything.
      this.connectOnce().catch((err: unknown) => {
        this.emit({ type: "error", message: errMsg(err) });
        if (this.stopped || !this.reconnect) return;
        this.scheduleReconnect(this.nextDelay());
      });
    }, delayMs);
    if (typeof this.reconnectTimer === "object" && "unref" in this.reconnectTimer) this.reconnectTimer.unref();
  }

  /** Restarts the dead-connection watchdog on every frame. */
  private armStaleTimer(): void {
    if (this.staleTimer) clearTimeout(this.staleTimer);
    if (this.staleAfterMs <= 0) return;
    this.staleTimer = setTimeout(() => {
      this.staleTimer = null;
      if (this.stopped) return;
      this.emit({ type: "error", message: `no frame from the engine for ${this.staleAfterMs}ms — reconnecting` });
      // Close it so the "close" handler runs the one reconnection path.
      try {
        this.socket?.close(1001, "stale connection");
      } catch {
        /* already closed */
      }
    }, this.staleAfterMs);
    if (typeof this.staleTimer === "object" && "unref" in this.staleTimer) this.staleTimer.unref();
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.reconnectTimer = null;
    this.staleTimer = null;
  }

  // --- frames --------------------------------------------------------------

  private onRaw(raw: string, settleOk: () => void, settleErr: (err: Error) => void): void {
    const parsed = parseServerFrame(raw);
    if (!parsed.ok) {
      this.emit({ type: "error", message: `unparseable frame from the engine: ${parsed.error}` });
      return;
    }
    const frame = parsed.frame;
    switch (frame.type) {
      case "hello.ok":
        this.sessionId = frame.sessionId;
        this.engineVersion = frame.engineVersion;
        this.warnings = frame.warnings;
        this.handshaken = true;
        this.emit({
          type: "connected",
          sessionId: frame.sessionId,
          engineVersion: frame.engineVersion,
          warnings: frame.warnings,
          tools: [...this.tools.keys()],
        });
        settleOk();
        return;
      case "hello.error":
        // Refused, not dropped: retrying cannot make a rejected token valid, so
        // the runtime stops here rather than hammering the engine.
        this.emit({ type: "handshake_rejected", reason: frame.reason });
        this.stopped = true;
        this.clearTimers();
        try {
          this.socket?.close(1000, "handshake rejected");
        } catch {
          /* already closed */
        }
        this.socket = null;
        settleErr(new Error(`dev handshake rejected: ${frame.reason}`));
        return;
      case "ping":
        this.send({ type: "pong" });
        return;
      case "tool.invoke":
        void this.serveInvoke(frame);
        return;
      case "tool.abort": {
        const call = this.inFlight.get(frame.callId);
        if (!call) return;
        call.aborted = true;
        this.inFlight.delete(frame.callId);
        for (const rpcId of call.rpcIds) {
          this.pendingRpcs.get(rpcId)?.reject(new Error("call aborted by the engine"));
          this.pendingRpcs.delete(rpcId);
        }
        this.emit({ type: "aborted", callId: frame.callId, tool: call.tool });
        return;
      }
      case "ctx.response": {
        const pending = this.pendingRpcs.get(frame.rpcId);
        if (!pending) return; // response to an RPC of an already-ended call
        this.pendingRpcs.delete(frame.rpcId);
        if (frame.ok) pending.resolve(frame.value);
        else pending.reject(new Error(frame.error ?? "ctx operation failed"));
        return;
      }
      default:
        return assertNever(frame);
    }
  }

  private async serveInvoke(frame: Extract<ServerFrame, { type: "tool.invoke" }>): Promise<void> {
    const { callId } = frame;
    const tool = this.tools.get(frame.tool);
    this.emit({ type: "invoke", callId, tool: frame.tool });
    if (!tool) {
      // The engine equipped a name this runtime no longer serves (a
      // `tools.update` that raced with a turn). An error result, not a silence:
      // the model gets a tool error and the developer gets the reason.
      this.reply({ callId, ok: false, error: `tool "${frame.tool}" is not served by this dev session` });
      this.emit({
        type: "result", callId, tool: frame.tool, ok: false, durationMs: 0,
        error: "tool not served by this dev session",
      });
      return;
    }

    const call: InFlightCall = { tool: frame.tool, aborted: false, rpcIds: new Set() };
    this.inFlight.set(callId, call);
    const proxy = createCtxProxy({ inline: frame.ctx, rpc: (op, args) => this.ctxRpc(callId, call, op, args) });
    const startedAt = Date.now();

    let ok: boolean;
    let result: unknown;
    let error: string | undefined;
    try {
      result = await tool.execute(frame.input, proxy.ctx);
      ok = true;
    } catch (err) {
      ok = false;
      error = errMsg(err);
    }
    const durationMs = Date.now() - startedAt;
    this.inFlight.delete(callId);

    // An aborted call's result is DISCARDED, never sent: the engine has already
    // settled it, and a late `tool.result` would be applying state writes for a
    // turn that no longer exists.
    if (call.aborted) return;

    this.reply({
      callId,
      ok,
      result: ok ? result : undefined,
      error,
      // Writes ride the result so the engine applies them only on success.
      stateWrites: ok ? proxy.stateWrites() : [],
      auditEntries: proxy.auditEntries(),
    });
    this.emit({ type: "result", callId, tool: frame.tool, ok, durationMs, ...(error ? { error } : {}) });
  }

  private ctxRpc(callId: string, call: InFlightCall, op: CtxOp, args: unknown[]): Promise<unknown> {
    if (call.aborted) return Promise.reject(new Error("call aborted by the engine"));
    if (!this.connected) return Promise.reject(new Error(`ctx.${op}: the dev session is not connected`));
    const rpcId = randomUUID();
    this.emit({ type: "ctx_request", callId, op });
    return new Promise<unknown>((resolve, reject) => {
      this.pendingRpcs.set(rpcId, { resolve, reject });
      call.rpcIds.add(rpcId);
      this.send({ type: "ctx.request", rpcId, callId, op, args });
    });
  }

  private reply(outcome: {
    callId: string;
    ok: boolean;
    result?: unknown;
    error?: string;
    stateWrites?: Extract<ClientFrame, { type: "tool.result" }>["stateWrites"];
    auditEntries?: Extract<ClientFrame, { type: "tool.result" }>["auditEntries"];
  }): void {
    this.send({
      type: "tool.result",
      callId: outcome.callId,
      ok: outcome.ok,
      result: outcome.result,
      error: outcome.error,
      stateWrites: outcome.stateWrites ?? [],
      auditEntries: outcome.auditEntries ?? [],
    });
  }

  private failAllPendingRpcs(message: string): void {
    for (const [rpcId, pending] of this.pendingRpcs) {
      pending.reject(new Error(message));
      this.pendingRpcs.delete(rpcId);
    }
  }

  private send(frame: ClientFrame): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) {
      this.emit({ type: "error", message: `dropped a "${frame.type}" frame: the socket is not open` });
      return;
    }
    try {
      socket.send(serializeClientFrame(frame));
    } catch (err) {
      this.emit({ type: "error", message: `could not send a "${frame.type}" frame: ${errMsg(err)}` });
    }
  }

  /** A throwing consumer must never take the session down with it. */
  private emit(event: DevSessionEvent): void {
    if (!this.onEvent) return;
    try {
      this.onEvent(event);
    } catch {
      /* a listener's fault is the listener's problem */
    }
  }
}

function indexTools(tools: readonly ToolDefinition[]): Map<string, ToolDefinition> {
  const map = new Map<string, ToolDefinition>();
  for (const tool of tools) {
    if (map.has(tool.name)) {
      // The engine rejects the whole handshake on a duplicate name; failing here
      // says which tool, before a socket is even opened.
      throw new Error(`duplicate tool name "${tool.name}": a dev session cannot declare it twice`);
    }
    map.set(tool.name, tool);
  }
  return map;
}

/** Accepts a full socket URL, or a base URL whose path is filled in. */
function resolveSocketUrl(url: string | undefined): string {
  if (!url) return DEFAULT_DEV_SOCKET_URL;
  const parsed = new URL(url);
  if (parsed.pathname === "" || parsed.pathname === "/") parsed.pathname = DEV_SOCKET_PATH;
  return parsed.toString();
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function assertNever(value: never): never {
  throw new Error(`unhandled server frame: ${JSON.stringify(value)}`);
}
