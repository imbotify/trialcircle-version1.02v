/**
 * Pure relationship semantics (Phase 0.5 reconciliation, items 2–3).
 *
 * This module is intentionally dependency-free so the exact same functions run
 * in the application and in the unit-test suite. The database unique index
 * `relationships_pair_label_unique` on (from, to, lower(label)) is the
 * physical backstop of the identity key defined here.
 */

export type RelationshipType = "mutual" | "directional";

/** Display label normalization: trim only. Casing and interior spacing are preserved. */
export function normalizeLabel(label: string): string {
  return label.trim();
}

/** Identity-key label normalization: trimmed + lowercased for comparison. */
export function keyLabel(label: string): string {
  return label.trim().toLowerCase();
}

export function isSelfLoop(fromPersonId: string, toPersonId: string): boolean {
  return fromPersonId === toPersonId;
}

/**
 * Canonical endpoint order.
 * - mutual: unordered pair → lexicographically smaller id first (RULE: storage
 *   form is canonical, so the DB unique index covers both submission orders).
 * - directional: ordered pair → stored order is significant and preserved.
 */
export function canonicalPair(
  fromPersonId: string,
  toPersonId: string,
  type: RelationshipType,
): [string, string] {
  if (type === "mutual" && fromPersonId > toPersonId) {
    return [toPersonId, fromPersonId];
  }
  return [fromPersonId, toPersonId];
}

/** Identity key: (from, to, lower(trim(label))). Type is an attribute, not identity. */
export function relationshipKey(fromPersonId: string, toPersonId: string, label: string): string {
  return `${fromPersonId}|${toPersonId}|${keyLabel(label)}`;
}

export function coerceType(value: unknown): RelationshipType {
  return value === "directional" ? "directional" : "mutual";
}

export function coerceViewMode(value: unknown): "circle" | "tree" {
  return value === "tree" ? "tree" : "circle";
}

export type MeEdge = {
  id: string;
  fromPersonId: string;
  toPersonId: string;
  label: string;
  createdAt: string | Date;
};

/**
 * The derived `relationshipToMe` display label: the oldest edge touching the Me
 * node for a given person. Deterministic tiebreak on id for identical timestamps.
 */
export function primaryMeLabel(
  edges: Array<{ id: string; fromPersonId: string; toPersonId: string; label: string; createdAt: string | Date }>,
  meId: string,
  personId: string,
): string | null {
  const relevant = edges.filter(
    (e) =>
      (e.fromPersonId === meId && e.toPersonId === personId) ||
      (e.fromPersonId === personId && e.toPersonId === meId),
  );
  if (!relevant.length) return null;
  relevant.sort((a, b) => {
    const at = new Date(a.createdAt).getTime();
    const bt = new Date(b.createdAt).getTime();
    if (at !== bt) return at - bt;
    return a.id < b.id ? -1 : 1;
  });
  return relevant[0].label;
}
