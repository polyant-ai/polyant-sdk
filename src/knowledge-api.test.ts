// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import type {
  KnowledgeAccessLevel,
  KnowledgeApi,
  KnowledgeDocumentContent,
  KnowledgeSearchHit,
  ToolContext,
} from "./context-types.js";

/**
 * Reference in-memory implementation of the documented `KnowledgeApi` contract.
 * This is the executable spec the engine accessor must honor:
 *
 * - the agent is implicit (no method takes one),
 * - `origin`/`originRef` are assigned by the implementation, never by the caller,
 * - a mutation below the granted level answers `not_granted`,
 * - a document owned by another writer answers `not_owned` until `manage`,
 * - there is no whole-base erase.
 */
function fakeKnowledge(
  level: KnowledgeAccessLevel,
  writer: { origin: KnowledgeDocumentContent["origin"]; ref: string | null },
  seed: KnowledgeDocumentContent[] = [],
): KnowledgeApi {
  const docs = new Map(seed.map((d) => [d.filename, { ...d }]));
  const summary = (d: KnowledgeDocumentContent) => {
    const { content: _content, ...rest } = d;
    return rest;
  };
  const allows = (needed: KnowledgeAccessLevel) => {
    const rank: Record<KnowledgeAccessLevel, number> = { read: 0, write: 1, manage: 2 };
    return rank[level] >= rank[needed];
  };
  const owns = (d: KnowledgeDocumentContent) =>
    d.origin === writer.origin && d.originRef === writer.ref;

  return {
    level,
    async search(query, opts) {
      const hits: KnowledgeSearchHit[] = [...docs.values()]
        .filter((d) => d.content.includes(query))
        .map((d, i) => ({ content: d.content, score: 1 / (i + 1), source: d.filename, chunkIndex: 0 }));
      return opts?.limit ? hits.slice(0, opts.limit) : hits;
    },
    async get(filename) {
      return docs.get(filename) ?? null;
    },
    async list(opts) {
      return [...docs.values()]
        .filter((d) => !opts?.origins || opts.origins.includes(d.origin))
        .filter((d) => !opts?.mineOnly || owns(d))
        .map(summary);
    },
    async write({ filename, content, mimeType }) {
      if (!allows("write")) return { ok: false, reason: "not_granted" };
      const existing = docs.get(filename);
      if (existing && !owns(existing) && !allows("manage")) return { ok: false, reason: "not_owned" };
      const doc: KnowledgeDocumentContent = {
        filename,
        content,
        mimeType: existing?.mimeType ?? mimeType ?? "text/markdown",
        sizeBytes: content.length,
        status: "ready",
        // Ownership is decided here, from the writer identity — not from input.
        origin: existing?.origin ?? writer.origin,
        originRef: existing?.originRef ?? writer.ref,
        updatedAt: "2026-09-08T00:00:00.000Z",
      };
      docs.set(filename, doc);
      return { ok: true, document: summary(doc), created: !existing };
    },
    async append({ filename, content }) {
      const existing = docs.get(filename);
      if (!existing) return this.write({ filename, content });
      return this.write({ filename, content: `${existing.content}\n\n${content}` });
    },
    async delete(filename) {
      if (!allows("manage")) return { ok: false, reason: "not_granted" };
      const existing = docs.get(filename);
      if (!existing) return { ok: false, reason: "not_found" };
      docs.delete(filename);
      return { ok: true, document: summary(existing), created: false };
    },
    async reingest(filename) {
      if (!allows("manage")) return { ok: false, reason: "not_granted" };
      const existing = docs.get(filename);
      if (!existing) return { ok: false, reason: "not_found" };
      return { ok: true, document: summary({ ...existing, status: "ready" }), created: false };
    },
  };
}

const PANEL_DOC: KnowledgeDocumentContent = {
  filename: "policy.md",
  content: "rimborsi entro 14 giorni",
  mimeType: "text/markdown",
  sizeBytes: 25,
  status: "ready",
  origin: "panel",
  originRef: null,
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const PLUGIN_WRITER = { origin: "plugin" as const, ref: "acme" };

const stubCtx = (over: Partial<ToolContext> = {}): ToolContext => ({
  instanceId: "inst" as ToolContext["instanceId"],
  audit: { log() {} },
  ...over,
});

describe("KnowledgeApi — grant semantics", () => {
  it("a ToolContext without `knowledge` is valid: absence IS the refusal", () => {
    expect(stubCtx().knowledge).toBeUndefined();
  });

  it("presence grants reads without a status wrapper", async () => {
    const ctx = stubCtx({ knowledge: fakeKnowledge("read", PLUGIN_WRITER, [PANEL_DOC]) });
    expect(await ctx.knowledge!.get("policy.md")).toMatchObject({ filename: "policy.md" });
    expect(await ctx.knowledge!.search("rimborsi")).toHaveLength(1);
    expect(await ctx.knowledge!.get("missing.md")).toBeNull();
  });

  it("refuses a mutation below the granted level, returning instead of throwing", async () => {
    const kb = fakeKnowledge("read", PLUGIN_WRITER);
    expect(await kb.write({ filename: "n.md", content: "x" })).toEqual({
      ok: false,
      reason: "not_granted",
    });
    expect(await kb.delete("policy.md")).toEqual({ ok: false, reason: "not_granted" });
  });

  it("`write` cannot overwrite a document it does not own", async () => {
    const kb = fakeKnowledge("write", PLUGIN_WRITER, [PANEL_DOC]);
    expect(await kb.write({ filename: "policy.md", content: "manomesso" })).toEqual({
      ok: false,
      reason: "not_owned",
    });
    // …and the panel's content is untouched.
    expect((await kb.get("policy.md"))!.content).toBe(PANEL_DOC.content);
  });

  it("`manage` can overwrite someone else's document", async () => {
    const kb = fakeKnowledge("manage", PLUGIN_WRITER, [PANEL_DOC]);
    const res = await kb.write({ filename: "policy.md", content: "aggiornato" });
    expect(res.ok).toBe(true);
    // Ownership does NOT transfer on overwrite: the document stays the panel's.
    expect(res.ok && res.document.origin).toBe("panel");
  });

  it("stamps origin from the writer identity, not from the caller's input", async () => {
    const kb = fakeKnowledge("write", PLUGIN_WRITER);
    const res = await kb.write({ filename: "notes.md", content: "x" });
    expect(res.ok && res.document).toMatchObject({ origin: "plugin", originRef: "acme", });
    expect(res.ok && res.created).toBe(true);
  });

  it("append creates when absent and concatenates when present", async () => {
    const kb = fakeKnowledge("write", PLUGIN_WRITER);
    expect((await kb.append({ filename: "log.md", content: "riga 1" })).ok).toBe(true);
    await kb.append({ filename: "log.md", content: "riga 2" });
    expect((await kb.get("log.md"))!.content).toBe("riga 1\n\nriga 2");
  });

  it("delete and reingest report not_found rather than succeeding vacuously", async () => {
    const kb = fakeKnowledge("manage", PLUGIN_WRITER);
    expect(await kb.delete("ghost.md")).toEqual({ ok: false, reason: "not_found" });
    expect(await kb.reingest("ghost.md")).toEqual({ ok: false, reason: "not_found" });
  });

  it("exposes no whole-base erase — wiping knowledge is a panel operation", () => {
    const kb = fakeKnowledge("manage", PLUGIN_WRITER);
    const surface = Object.keys(kb).sort();
    expect(surface).toEqual(
      ["append", "delete", "get", "level", "list", "reingest", "search", "write"],
    );
  });

  it("list narrows by origin and by ownership", async () => {
    const kb = fakeKnowledge("write", PLUGIN_WRITER, [PANEL_DOC]);
    await kb.write({ filename: "notes.md", content: "x" });
    expect((await kb.list()).map((d) => d.filename).sort()).toEqual(["notes.md", "policy.md"]);
    expect((await kb.list({ mineOnly: true })).map((d) => d.filename)).toEqual(["notes.md"]);
    expect((await kb.list({ origins: ["panel"] })).map((d) => d.filename)).toEqual(["policy.md"]);
  });
});
