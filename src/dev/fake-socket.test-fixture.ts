// SPDX-License-Identifier: Apache-2.0

/**
 * An in-memory {@link DevWebSocketLike} for the tests in this directory.
 *
 * Named `.test-fixture.ts` and excluded from the build: it is not part of the
 * published surface, but it is shared by more than one test file, so it cannot
 * live inside one of them.
 */

import { clientFrameSchema, serverFrameSchema, type ClientFrame, type ServerFrame } from "./protocol.js";
import type { DevSocketEvent, DevSocketEventType, DevWebSocketLike } from "./websocket.js";

export class FakeDevSocket implements DevWebSocketLike {
  readyState = 0;
  /** Raw frames the runtime sent, in order. */
  readonly sent: string[] = [];
  readonly closeCalls: { code?: number; reason?: string }[] = [];

  private readonly listeners = new Map<DevSocketEventType, ((event: DevSocketEvent) => void)[]>();

  addEventListener(type: DevSocketEventType, listener: (event: DevSocketEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.fire("close", { code, reason });
  }

  /** Simulate the connection opening. */
  open(): void {
    this.readyState = 1;
    this.fire("open", {});
  }

  /** Simulate the engine sending a frame — validated with the engine's own
   *  schema, so a fake engine cannot send what the real one could not. */
  deliver(frame: ServerFrame): void {
    this.fire("message", { data: JSON.stringify(serverFrameSchema.parse(frame)) });
  }

  /** Simulate a transport error. */
  fail(message: string): void {
    this.fire("error", { message });
  }

  /** The frames the runtime sent, VALIDATED against the server's own schema. */
  frames(): ClientFrame[] {
    return this.sent.map((raw) => clientFrameSchema.parse(JSON.parse(raw)));
  }

  framesOf<T extends ClientFrame["type"]>(type: T): Extract<ClientFrame, { type: T }>[] {
    return this.frames().filter((f): f is Extract<ClientFrame, { type: T }> => f.type === type);
  }

  private fire(type: DevSocketEventType, event: DevSocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}
