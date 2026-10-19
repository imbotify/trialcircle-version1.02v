/**
 * Unit tests: relationship semantics (Phase 0.5, items 2-3).
 * Pure functions — no server, no database.
 * Run: npx tsx --test tests/unit/*.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalPair,
  coerceType,
  coerceViewMode,
  isSelfLoop,
  keyLabel,
  normalizeLabel,
  primaryMeLabel,
  relationshipKey,
} from "../../src/lib/relationships";

describe("normalizeLabel / keyLabel", () => {
  it("trims for display but preserves casing and interior spacing", () => {
    assert.equal(normalizeLabel("  Childhood  Friends "), "Childhood  Friends");
  });
  it("lowercases and trims for identity comparison", () => {
    assert.equal(keyLabel("  Best Friend "), "best friend");
    assert.equal(keyLabel("COUSIN"), "cousin");
  });
});

describe("isSelfLoop", () => {
  it("detects self connections", () => {
    assert.equal(isSelfLoop("a", "a"), true);
    assert.equal(isSelfLoop("a", "b"), false);
  });
});

describe("canonicalPair", () => {
  it("sorts mutual endpoints (smaller id first)", () => {
    assert.deepEqual(canonicalPair("b-id", "a-id", "mutual"), ["a-id", "b-id"]);
    assert.deepEqual(canonicalPair("a-id", "b-id", "mutual"), ["a-id", "b-id"]);
  });
  it("preserves directional order", () => {
    assert.deepEqual(canonicalPair("b-id", "a-id", "directional"), ["b-id", "a-id"]);
  });
  it("is stable: canonical(canonical(x)) === canonical(x)", () => {
    const once = canonicalPair("z", "m", "mutual");
    assert.deepEqual(canonicalPair(once[0], once[1], "mutual"), once);
  });
});

describe("relationshipKey", () => {
  it("builds (from, to, lower(label)) keys", () => {
    assert.equal(relationshipKey("a", "b", "  Cousin "), "a|b|cousin");
  });
  it("treats case variants as the same key", () => {
    assert.equal(relationshipKey("a", "b", "Friends"), relationshipKey("a", "b", "FRIENDS"));
  });
  it("treats different labels and orders as different keys", () => {
    assert.notEqual(relationshipKey("a", "b", "Friends"), relationshipKey("a", "b", "Colleagues"));
    assert.notEqual(relationshipKey("a", "b", "Friends"), relationshipKey("b", "a", "Friends"));
  });
});

describe("coercions", () => {
  it("coerceType defaults to mutual", () => {
    assert.equal(coerceType("directional"), "directional");
    assert.equal(coerceType("mutual"), "mutual");
    assert.equal(coerceType("anything-else"), "mutual");
    assert.equal(coerceType(undefined), "mutual");
  });
  it("coerceViewMode defaults to circle", () => {
    assert.equal(coerceViewMode("tree"), "tree");
    assert.equal(coerceViewMode("circle"), "circle");
    assert.equal(coerceViewMode("bogus"), "circle");
  });
});

describe("primaryMeLabel (RULE R1 derivation)", () => {
  const edges = [
    { id: "e2", fromPersonId: "me", toPersonId: "x", label: "Business Partner", createdAt: "2024-02-01" },
    { id: "e1", fromPersonId: "x", toPersonId: "me", label: "Brother", createdAt: "2024-01-01" },
  ];
  it("returns the oldest Me-edge label regardless of direction", () => {
    assert.equal(primaryMeLabel(edges, "me", "x"), "Brother");
  });
  it("returns null when no Me-edge exists", () => {
    assert.equal(primaryMeLabel(edges, "me", "stranger"), null);
  });
  it("ignores edges that do not touch Me", () => {
    const other = [{ id: "e9", fromPersonId: "a", toPersonId: "b", label: "Friends", createdAt: "2020-01-01" }];
    assert.equal(primaryMeLabel(other, "me", "a"), null);
  });
  it("breaks timestamp ties deterministically by id", () => {
    const tied = [
      { id: "e-b", fromPersonId: "me", toPersonId: "x", label: "Second", createdAt: "2024-01-01" },
      { id: "e-a", fromPersonId: "me", toPersonId: "x", label: "First", createdAt: "2024-01-01" },
    ];
    assert.equal(primaryMeLabel(tied, "me", "x"), "First");
  });
});
