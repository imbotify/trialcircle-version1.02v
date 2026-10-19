/**
 * Unit tests: graph traversal + layout fallback (Phase 0.5, item 2c/2d/5).
 * Pure functions — no server, no database.
 * Run: npx tsx --test tests/unit/*.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { autoLayout, findPath, neighboursOf } from "../../src/components/graph/layout";

function person(id: string, isMe = false) {
  return {
    id,
    spaceId: "s1",
    name: id,
    avatarUrl: null,
    relationshipToMe: null,
    tags: [],
    isMe,
    createdAt: new Date().toISOString(),
  };
}

function edge(id: string, from: string, to: string, type: "mutual" | "directional" = "mutual") {
  return { id, spaceId: "s1", fromPersonId: from, toPersonId: to, label: "L", type };
}

describe("neighboursOf", () => {
  it("collects neighbours in both directions", () => {
    const edges = [edge("e1", "a", "b"), edge("e2", "c", "a", "directional")];
    assert.deepEqual([...neighboursOf(edges, "a")].sort(), ["b", "c"]);
    assert.deepEqual([...neighboursOf(edges, "b")], ["a"]);
  });
});

describe("findPath (RULE P1: BFS over real edges)", () => {
  const edges = [
    edge("e1", "me", "rahul"),
    edge("e2", "rahul", "tara"),
    edge("e3", "tara", "arjun"),
    edge("e4", "me", "priya"),
  ];
  it("finds the shortest multi-hop path", () => {
    assert.deepEqual(findPath(edges, "me", "arjun"), ["me", "rahul", "tara", "arjun"]);
  });
  it("prefers the direct edge when one exists", () => {
    assert.deepEqual(findPath(edges, "me", "priya"), ["me", "priya"]);
  });
  it("ignores direction for connectivity", () => {
    const directed = [edge("e1", "a", "b", "directional")];
    assert.deepEqual(findPath(directed, "b", "a"), ["b", "a"]);
  });
  it("returns [self] for self queries", () => {
    assert.deepEqual(findPath(edges, "me", "me"), ["me"]);
  });
  it("returns null when disconnected", () => {
    assert.equal(findPath(edges, "me", "ghost"), null);
  });
  it("terminates on cycles", () => {
    const cyclic = [edge("e1", "a", "b"), edge("e2", "b", "c"), edge("e3", "c", "a")];
    assert.deepEqual(findPath(cyclic, "a", "c"), ["a", "c"]);
  });
});

describe("autoLayout (fallback only — persisted positions always win)", () => {
  it("centers Me and places everyone in circle mode", () => {
    const people = [person("me", true), person("a"), person("b")];
    const layout = autoLayout(people, [edge("e1", "me", "a")], "circle");
    assert.deepEqual(layout.me, { x: 0, y: 0 });
    assert.ok(layout.a && layout.b, "every node gets a position");
  });
  it("places disconnected people instead of dropping them", () => {
    const people = [person("me", true), person("loner")];
    const layout = autoLayout(people, [], "circle");
    assert.ok(layout.loner, "disconnected node still placed");
  });
  it("layers tree mode by BFS depth from Me (exploration layers, not hierarchy)", () => {
    const people = [person("me", true), person("a"), person("b")];
    const layout = autoLayout(people, [edge("e1", "me", "a"), edge("e2", "a", "b")], "tree");
    assert.ok(layout.me.y < layout.a.y, "depth 1 below Me");
    assert.ok(layout.a.y < layout.b.y, "depth 2 below depth 1");
  });
  it("handles a graph of only Me", () => {
    const layout = autoLayout([person("me", true)], [], "circle");
    assert.deepEqual(layout.me, { x: 0, y: 0 });
  });
});
