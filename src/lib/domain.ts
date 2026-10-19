import { and, asc, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  customFields,
  graphLayouts,
  media,
  memories,
  people,
  relationships,
  spaces,
  userFields,
  users,
  type User,
} from "@/db/schema";
import { HttpError } from "@/lib/auth";
import {
  canonicalPair,
  coerceType,
  coerceViewMode,
  isSelfLoop,
  keyLabel,
  normalizeLabel,
} from "@/lib/relationships";

/* ------------------------------------------------------------------ */
/* validation helpers                                                  */
/* ------------------------------------------------------------------ */

export function text(
  value: unknown,
  field: string,
  opts: { max?: number; required?: boolean; min?: number } = {},
): string {
  const { max = 200, required = false, min = 1 } = opts;
  if (value === undefined || value === null) {
    if (required) throw new HttpError(422, `${field} is required.`);
    return "";
  }
  if (typeof value !== "string") throw new HttpError(422, `${field} must be text.`);
  const trimmed = value.trim();
  if (required && trimmed.length < min) throw new HttpError(422, `${field} is required.`);
  if (trimmed.length > max) throw new HttpError(422, `${field} must be under ${max} characters.`);
  return trimmed;
}

export function optionalText(value: unknown, field: string, max = 2000): string | null {
  const v = text(value, field, { max, required: false });
  return v.length ? v : null;
}

export function tagList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.slice(0, 24)) {
    const t = text(raw, "Tag", { max: 40 });
    const key = t.toLowerCase();
    if (t && !seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* ownership guards                                                    */
/* ------------------------------------------------------------------ */

export async function requireSpace(user: User, spaceId: string) {
  if (!isUuid(spaceId)) throw new HttpError(404, "Space not found.");
  const [space] = await db
    .select()
    .from(spaces)
    .where(and(eq(spaces.id, spaceId), eq(spaces.userId, user.id)))
    .limit(1);
  if (!space) throw new HttpError(404, "Space not found.");
  return space;
}

export async function requirePerson(user: User, personId: string) {
  if (!isUuid(personId)) throw new HttpError(404, "Person not found.");
  const [row] = await db
    .select({ person: people, space: spaces })
    .from(people)
    .innerJoin(spaces, eq(spaces.id, people.spaceId))
    .where(and(eq(people.id, personId), eq(spaces.userId, user.id)))
    .limit(1);
  if (!row) throw new HttpError(404, "Person not found.");
  return row;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/* ------------------------------------------------------------------ */
/* view models                                                         */
/* ------------------------------------------------------------------ */

export type PersonView = {
  id: string;
  spaceId: string;
  name: string;
  avatarUrl: string | null;
  relationshipToMe: string | null;
  tags: string[];
  isMe: boolean;
  createdAt: string;
};

/**
 * RULE R1 (Phase 0.5, item 1): `relationshipToMe` is DERIVED from the oldest
 * Me↔person edge. Callers must supply the label computed from real edge rows —
 * there is no stored copy anywhere.
 */
export function toPersonView(
  person: typeof people.$inferSelect,
  account: { displayName: string; avatarUrl: string | null },
  meLabel: string | null = null,
): PersonView {
  return {
    id: person.id,
    spaceId: person.spaceId,
    name: person.isMe ? person.name || account.displayName : person.name || "Unnamed",
    avatarUrl: person.isMe ? person.avatarUrl ?? account.avatarUrl : person.avatarUrl,
    relationshipToMe: person.isMe ? "This is you" : meLabel,
    tags: person.tags ?? [],
    isMe: person.isMe,
    createdAt: person.createdAt.toISOString(),
  };
}

type EdgeLike = {
  id: string;
  fromPersonId: string;
  toPersonId: string;
  label: string;
  createdAt: Date;
};

/** Derived Me-label for every person touched by the Me node in an edge list. Oldest edge wins. */
export function meLabelMap(edges: EdgeLike[], meId: string | null): Map<string, string> {
  const best = new Map<string, { label: string; at: number; id: string }>();
  if (!meId) return new Map();
  for (const e of edges) {
    const other =
      e.fromPersonId === meId ? e.toPersonId : e.toPersonId === meId ? e.fromPersonId : null;
    if (!other) continue;
    const at = new Date(e.createdAt).getTime();
    const cur = best.get(other);
    if (!cur || at < cur.at || (at === cur.at && e.id < cur.id)) {
      best.set(other, { label: e.label, at, id: e.id });
    }
  }
  return new Map([...best].map(([k, v]) => [k, v.label]));
}

/** Derived Me-labels across several (owned) spaces — used by aggregation views. */
export async function meLabelsForSpaces(user: User, spaceIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!spaceIds.length) return map;
  const owned = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(eq(spaces.userId, user.id), inArray(spaces.id, spaceIds)));
  const ownedIds = owned.map((s) => s.id);
  if (!ownedIds.length) return map;
  const meRows = await db
    .select({ id: people.id })
    .from(people)
    .where(and(inArray(people.spaceId, ownedIds), eq(people.isMe, true)));
  const meIds = meRows.map((m) => m.id);
  if (!meIds.length) return map;
  const edgeRows = await db
    .select({
      fromPersonId: relationships.fromPersonId,
      toPersonId: relationships.toPersonId,
      label: relationships.label,
    })
    .from(relationships)
    .where(
      and(
        inArray(relationships.spaceId, ownedIds),
        or(inArray(relationships.fromPersonId, meIds), inArray(relationships.toPersonId, meIds)),
      ),
    )
    .orderBy(asc(relationships.createdAt), asc(relationships.id));
  const meSet = new Set(meIds);
  for (const e of edgeRows) {
    const other = meSet.has(e.fromPersonId) ? e.toPersonId : e.fromPersonId;
    if (!map.has(other)) map.set(other, e.label);
  }
  return map;
}

/** RULE D3: renaming/creating must not collide with another row's identity key. */
async function assertNoKeyConflict(
  spaceId: string,
  fromPersonId: string,
  toPersonId: string,
  label: string,
  excludeId?: string,
) {
  const conditions = [
    eq(relationships.spaceId, spaceId),
    eq(relationships.fromPersonId, fromPersonId),
    eq(relationships.toPersonId, toPersonId),
    sql`lower(relationships.label) = ${keyLabel(label)}`,
  ];
  if (excludeId) conditions.push(ne(relationships.id, excludeId));
  const rows = await db.select({ id: relationships.id }).from(relationships).where(and(...conditions)).limit(1);
  if (rows.length) {
    throw new HttpError(
      409,
      `These two people already have a "${label}" relationship. Edit that connection instead.`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* spaces                                                              */
/* ------------------------------------------------------------------ */

export async function listSpaces(user: User) {
  const rows = await db
    .select({
      space: spaces,
      // NOTE: column references inside sql`` templates must be fully qualified —
      // Drizzle emits bare identifiers which would resolve against the subquery's
      // own FROM clause and silently return zero.
      peopleCount: sql<number>`(
        select count(*)::int from people pc
        where pc.space_id = spaces.id and pc.is_me = false
      )`,
      connectionCount: sql<number>`(
        select count(*)::int from relationships rc
        where rc.space_id = spaces.id
      )`,
    })
    .from(spaces)
    .where(eq(spaces.userId, user.id))
    .orderBy(desc(spaces.updatedAt));

  return rows.map((r) => ({
    id: r.space.id,
    name: r.space.name,
    description: r.space.description,
    icon: r.space.icon,
    color: r.space.color,
    peopleCount: r.peopleCount,
    connectionCount: r.connectionCount,
    updatedAt: r.space.updatedAt.toISOString(),
  }));
}

export type SpaceSummary = Awaited<ReturnType<typeof listSpaces>>[number];

export async function createSpace(user: User, input: Record<string, unknown>) {
  const name = text(input.name, "Space name", { max: 60, required: true });
  const description = optionalText(input.description, "Description", 280);
  const icon = text(input.icon, "Icon", { max: 8 }) || "🏠";
  const color = /^#[0-9a-f]{6}$/i.test(String(input.color ?? "")) ? String(input.color) : "#6366F1";

  return db.transaction(async (tx) => {
    const [space] = await tx
      .insert(spaces)
      .values({ userId: user.id, name, description, icon, color })
      .returning();
    const [me] = await tx
      .insert(people)
      .values({ spaceId: space.id, isMe: true, tags: [] })
      .returning();
    await tx.insert(graphLayouts).values([
      { spaceId: space.id, personId: me.id, viewMode: "circle", x: 0, y: 0 },
      { spaceId: space.id, personId: me.id, viewMode: "tree", x: 0, y: -160 },
    ]);
    return space;
  });
}

export async function updateSpace(user: User, spaceId: string, input: Record<string, unknown>) {
  await requireSpace(user, spaceId);
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if ("name" in input) patch.name = text(input.name, "Space name", { max: 60, required: true });
  if ("description" in input) patch.description = optionalText(input.description, "Description", 280);
  if ("icon" in input) patch.icon = text(input.icon, "Icon", { max: 8 }) || "🏠";
  if ("color" in input && /^#[0-9a-f]{6}$/i.test(String(input.color))) patch.color = String(input.color);
  const [updated] = await db.update(spaces).set(patch).where(eq(spaces.id, spaceId)).returning();
  return updated;
}

export async function deleteSpace(user: User, spaceId: string) {
  await requireSpace(user, spaceId);
  await db.delete(spaces).where(eq(spaces.id, spaceId));
}

export async function touchSpace(spaceId: string) {
  await db.update(spaces).set({ updatedAt: new Date() }).where(eq(spaces.id, spaceId));
}

/* ------------------------------------------------------------------ */
/* graph                                                               */
/* ------------------------------------------------------------------ */

export async function getSpaceGraph(user: User, spaceId: string) {
  const space = await requireSpace(user, spaceId);
  const [peopleRows, edgeRows, layoutRows] = await Promise.all([
    db.select().from(people).where(eq(people.spaceId, spaceId)).orderBy(desc(people.isMe), asc(people.createdAt)),
    db.select().from(relationships).where(eq(relationships.spaceId, spaceId)).orderBy(asc(relationships.createdAt)),
    db.select().from(graphLayouts).where(eq(graphLayouts.spaceId, spaceId)),
  ]);

  const meId = peopleRows.find((p) => p.isMe)?.id ?? null;
  const labels = meLabelMap(edgeRows, meId);

  return {
    space: {
      id: space.id,
      name: space.name,
      description: space.description,
      icon: space.icon,
      color: space.color,
      updatedAt: space.updatedAt.toISOString(),
    },
    people: peopleRows.map((p) => toPersonView(p, user, labels.get(p.id) ?? null)),
    relationships: edgeRows.map((r) => ({
      id: r.id,
      spaceId: r.spaceId,
      fromPersonId: r.fromPersonId,
      toPersonId: r.toPersonId,
      label: r.label,
      type: r.type as "mutual" | "directional",
    })),
    layouts: layoutRows.map((l) => ({
      personId: l.personId,
      viewMode: l.viewMode as "circle" | "tree",
      x: l.x,
      y: l.y,
    })),
  };
}

export type SpaceGraph = Awaited<ReturnType<typeof getSpaceGraph>>;

export async function saveLayout(
  user: User,
  spaceId: string,
  viewMode: string,
  positions: Array<{ personId: string; x: number; y: number }>,
) {
  await requireSpace(user, spaceId);
  const mode = coerceViewMode(viewMode);
  const valid = positions.filter(
    (p) => isUuid(p.personId) && Number.isFinite(p.x) && Number.isFinite(p.y),
  );
  if (!valid.length) return;
  const ids = valid.map((p) => p.personId);
  const owned = await db
    .select({ id: people.id })
    .from(people)
    .where(and(eq(people.spaceId, spaceId), inArray(people.id, ids)));
  const ownedIds = new Set(owned.map((o) => o.id));
  const rows = valid
    .filter((p) => ownedIds.has(p.personId))
    .map((p) => ({ spaceId, personId: p.personId, viewMode: mode, x: p.x, y: p.y }));
  if (!rows.length) return;
  await db
    .insert(graphLayouts)
    .values(rows)
    .onConflictDoUpdate({
      target: [graphLayouts.spaceId, graphLayouts.viewMode, graphLayouts.personId],
      set: { x: sql`excluded.x`, y: sql`excluded.y`, updatedAt: new Date() },
    });
}

/* ------------------------------------------------------------------ */
/* people                                                              */
/* ------------------------------------------------------------------ */

export async function createPerson(user: User, spaceId: string, input: Record<string, unknown>) {
  await requireSpace(user, spaceId);
  const name = text(input.name, "Name", { max: 80, required: true });
  const relationshipLabel = optionalText(input.relationshipToMe, "Relationship", 60);
  const avatarUrl = optionalText(input.avatarUrl, "Photo", 600);
  const tags = tagList(input.tags);
  const position = (input.position ?? {}) as { x?: number; y?: number };

  return db.transaction(async (tx) => {
    const [person] = await tx
      .insert(people)
      .values({ spaceId, name, avatarUrl, tags })
      .returning();

    const [meRow] = await tx
      .select()
      .from(people)
      .where(and(eq(people.spaceId, spaceId), eq(people.isMe, true)))
      .limit(1);

    // RULE R1: the initial "relationship to me" exists ONLY as a graph edge.
    // With connectToMe === false a supplied label is meaningless and ignored.
    if (meRow && relationshipLabel && input.connectToMe !== false) {
      const [fromPersonId, toPersonId] = canonicalPair(meRow.id, person.id, "mutual");
      await tx
        .insert(relationships)
        .values({
          spaceId,
          fromPersonId,
          toPersonId,
          label: normalizeLabel(relationshipLabel),
          type: "mutual",
        })
        .onConflictDoNothing();
    }

    const x = Number(position?.x);
    const y = Number(position?.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      await tx.insert(graphLayouts).values([
        { spaceId, personId: person.id, viewMode: "circle", x, y },
      ]);
    }
    await tx.update(spaces).set({ updatedAt: new Date() }).where(eq(spaces.id, spaceId));
    return person;
  });
}

export async function updatePerson(user: User, personId: string, input: Record<string, unknown>) {
  const { person } = await requirePerson(user, personId);
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if ("name" in input) {
    const name = text(input.name, "Name", { max: 80, required: !person.isMe });
    patch.name = name.length ? name : null;
  }
  if ("avatarUrl" in input) patch.avatarUrl = optionalText(input.avatarUrl, "Photo", 600);
  if ("tags" in input) patch.tags = tagList(input.tags);
  const [updated] = await db.update(people).set(patch).where(eq(people.id, personId)).returning();
  // RULE R1: the profile field maps onto the primary (oldest) Me-edge.
  if ("relationshipToMe" in input && !person.isMe) {
    await syncPrimaryMeEdge(person, optionalText(input.relationshipToMe, "Relationship", 60));
  }
  await touchSpace(person.spaceId);
  return updated;
}

/**
 * Maps the profile "Relationship to me" field onto the primary (oldest) Me-edge:
 * label provided → rename it (conflict-checked) or create it; label cleared →
 * delete the primary edge only. Further Me-edges are managed via Connections.
 */
async function syncPrimaryMeEdge(
  person: typeof people.$inferSelect,
  label: string | null,
) {
  const [meRow] = await db
    .select()
    .from(people)
    .where(and(eq(people.spaceId, person.spaceId), eq(people.isMe, true)))
    .limit(1);
  if (!meRow) return;
  const edges = await db
    .select()
    .from(relationships)
    .where(
      and(
        eq(relationships.spaceId, person.spaceId),
        or(
          and(eq(relationships.fromPersonId, meRow.id), eq(relationships.toPersonId, person.id)),
          and(eq(relationships.fromPersonId, person.id), eq(relationships.toPersonId, meRow.id)),
        ),
      ),
    )
    .orderBy(asc(relationships.createdAt), asc(relationships.id));
  const primary = edges[0];
  if (!label) {
    if (primary) await db.delete(relationships).where(eq(relationships.id, primary.id));
    return;
  }
  const clean = normalizeLabel(label);
  if (!clean) {
    if (primary) await db.delete(relationships).where(eq(relationships.id, primary.id));
    return;
  }
  if (primary) {
    if (primary.label === clean) return;
    await assertNoKeyConflict(person.spaceId, primary.fromPersonId, primary.toPersonId, clean, primary.id);
    await db
      .update(relationships)
      .set({ label: clean, updatedAt: new Date() })
      .where(eq(relationships.id, primary.id));
    return;
  }
  const [fromPersonId, toPersonId] = canonicalPair(meRow.id, person.id, "mutual");
  await db
    .insert(relationships)
    .values({ spaceId: person.spaceId, fromPersonId, toPersonId, label: clean, type: "mutual" })
    .onConflictDoNothing();
}

export async function deletePerson(user: User, personId: string) {
  const { person } = await requirePerson(user, personId);
  if (person.isMe) throw new HttpError(422, "The Me node anchors this Space and cannot be removed.");
  // FK cascades remove relationships, fields, media, memories and layout rows.
  await db.delete(people).where(eq(people.id, personId));
  await touchSpace(person.spaceId);
}

export async function getPersonDetail(user: User, personId: string) {
  const { person, space } = await requirePerson(user, personId);
  const [fieldRows, mediaRows, memoryRows, edgeRows, spacePeople] = await Promise.all([
    db.select().from(customFields).where(eq(customFields.personId, personId)).orderBy(asc(customFields.sortOrder), asc(customFields.createdAt)),
    db.select().from(media).where(eq(media.personId, personId)).orderBy(desc(media.createdAt)),
    db.select().from(memories).where(eq(memories.personId, personId)).orderBy(desc(memories.eventDate)),
    db
      .select()
      .from(relationships)
      .where(
        and(
          eq(relationships.spaceId, person.spaceId),
          or(eq(relationships.fromPersonId, personId), eq(relationships.toPersonId, personId)),
        ),
      ),
    db.select().from(people).where(eq(people.spaceId, person.spaceId)),
  ]);

  const meId = spacePeople.find((p) => p.isMe)?.id ?? null;
  const labels = meLabelMap(edgeRows, meId);
  const byId = new Map(spacePeople.map((p) => [p.id, toPersonView(p, user, labels.get(p.id) ?? null)]));

  return {
    person: toPersonView(person, user, labels.get(person.id) ?? null),
    space: { id: space.id, name: space.name, icon: space.icon, color: space.color },
    fields: fieldRows.map((f) => ({ id: f.id, label: f.label, value: f.value, sortOrder: f.sortOrder })),
    media: mediaRows.map((m) => ({
      id: m.id,
      kind: m.kind as "photo" | "document",
      fileName: m.fileName,
      mimeType: m.mimeType,
      sizeBytes: m.sizeBytes,
      caption: m.caption,
      url: m.externalUrl ?? `/api/media/${m.id}`,
      createdAt: m.createdAt.toISOString(),
    })),
    memories: memoryRows.map((m) => ({
      id: m.id,
      title: m.title,
      description: m.description,
      eventDate: m.eventDate,
      // Item 7: the attached media row is the source of truth; legacy image_url
      // survives as a read-only fallback for pre-reconciliation rows.
      imageUrl: m.imageMediaId ? `/api/media/${m.imageMediaId}` : m.imageUrl,
      icon: m.icon,
    })),
    connections: edgeRows
      .map((edge) => {
        const otherId = edge.fromPersonId === personId ? edge.toPersonId : edge.fromPersonId;
        const other = byId.get(otherId);
        if (!other) return null;
        return {
          relationshipId: edge.id,
          label: edge.label,
          type: edge.type as "mutual" | "directional",
          direction: (edge.fromPersonId === personId ? "outgoing" : "incoming") as "outgoing" | "incoming",
          person: other,
        };
      })
      .filter((c): c is NonNullable<typeof c> => Boolean(c)),
  };
}

export type PersonDetail = Awaited<ReturnType<typeof getPersonDetail>>;

/* ------------------------------------------------------------------ */
/* relationships                                                       */
/* ------------------------------------------------------------------ */

export async function createRelationship(user: User, input: Record<string, unknown>) {
  const fromId = text(input.fromPersonId, "Person A", { max: 64, required: true });
  const toId = text(input.toPersonId, "Person B", { max: 64, required: true });
  const label = normalizeLabel(text(input.label, "Relationship", { max: 60, required: true }));
  const type = coerceType(input.type);

  if (isSelfLoop(fromId, toId)) {
    throw new HttpError(422, "A person cannot be connected to themselves.");
  }

  const personA = await requirePerson(user, fromId);
  const personB = await requirePerson(user, toId);
  const spaceId = personA.person.spaceId;
  if (spaceId !== personB.person.spaceId) {
    throw new HttpError(422, "People can only be connected inside the same Space.");
  }

  // Canonical storage form: mutual rows are endpoint-sorted so the identity key
  // (from, to, lower(label)) covers both submission orders (RULE D1).
  const [fromPersonId, toPersonId] = canonicalPair(fromId, toId, type);

  const [existing] = await db
    .select()
    .from(relationships)
    .where(
      and(
        eq(relationships.spaceId, spaceId),
        eq(relationships.fromPersonId, fromPersonId),
        eq(relationships.toPersonId, toPersonId),
        sql`lower(relationships.label) = ${keyLabel(label)}`,
      ),
    )
    .limit(1);
  if (existing) {
    if (existing.type !== type) {
      throw new HttpError(
        409,
        `These two people already have a "${existing.label}" relationship. Edit that connection to change its type.`,
      );
    }
    return { relationship: existing, created: false };
  }

  const [created] = await db
    .insert(relationships)
    .values({ spaceId, fromPersonId, toPersonId, label, type })
    .returning();
  await touchSpace(spaceId);
  return { relationship: created, created: true };
}

export async function requireRelationship(user: User, relationshipId: string) {
  if (!isUuid(relationshipId)) throw new HttpError(404, "Connection not found.");
  const [row] = await db
    .select({ rel: relationships })
    .from(relationships)
    .innerJoin(spaces, eq(spaces.id, relationships.spaceId))
    .where(and(eq(relationships.id, relationshipId), eq(spaces.userId, user.id)))
    .limit(1);
  if (!row) throw new HttpError(404, "Connection not found.");
  return row.rel;
}

export async function updateRelationship(
  user: User,
  relationshipId: string,
  input: Record<string, unknown>,
) {
  const rel = await requireRelationship(user, relationshipId);
  let fromPersonId = rel.fromPersonId;
  let toPersonId = rel.toPersonId;
  let label = rel.label;
  let type = coerceType(rel.type);
  if ("label" in input) label = normalizeLabel(text(input.label, "Relationship", { max: 60, required: true }));
  if ("type" in input) type = coerceType(input.type);
  if (input.swap === true && type === "directional") {
    [fromPersonId, toPersonId] = [toPersonId, fromPersonId];
  }
  // Type flips recompute storage order: mutual re-sorts to canonical order,
  // directional keeps the stored order as the direction.
  [fromPersonId, toPersonId] = canonicalPair(fromPersonId, toPersonId, type);
  // RULE D3: renames/retypes must not collide with another row's identity key.
  await assertNoKeyConflict(rel.spaceId, fromPersonId, toPersonId, label, rel.id);
  const [updated] = await db
    .update(relationships)
    .set({ fromPersonId, toPersonId, label, type, updatedAt: new Date() })
    .where(eq(relationships.id, relationshipId))
    .returning();
  await touchSpace(rel.spaceId);
  return updated;
}

export async function deleteRelationship(user: User, relationshipId: string) {
  const rel = await requireRelationship(user, relationshipId);
  await db.delete(relationships).where(eq(relationships.id, relationshipId));
  await touchSpace(rel.spaceId);
}

/* ------------------------------------------------------------------ */
/* custom fields                                                       */
/* ------------------------------------------------------------------ */

export async function createField(user: User, personId: string, input: Record<string, unknown>) {
  const { person } = await requirePerson(user, personId);
  const label = text(input.label, "Field name", { max: 60, required: true });
  const value = text(input.value, "Field value", { max: 500 });
  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(custom_fields.sort_order), -1)::int` })
    .from(customFields)
    .where(eq(customFields.personId, personId));
  const [created] = await db
    .insert(customFields)
    .values({ personId, label, value, sortOrder: max + 1 })
    .returning();
  await touchSpace(person.spaceId);
  return created;
}

export async function requireField(user: User, fieldId: string) {
  if (!isUuid(fieldId)) throw new HttpError(404, "Field not found.");
  const [row] = await db
    .select({ field: customFields, person: people })
    .from(customFields)
    .innerJoin(people, eq(people.id, customFields.personId))
    .innerJoin(spaces, eq(spaces.id, people.spaceId))
    .where(and(eq(customFields.id, fieldId), eq(spaces.userId, user.id)))
    .limit(1);
  if (!row) throw new HttpError(404, "Field not found.");
  return row;
}

export async function updateField(user: User, fieldId: string, input: Record<string, unknown>) {
  const { person } = await requireField(user, fieldId);
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if ("label" in input) patch.label = text(input.label, "Field name", { max: 60, required: true });
  if ("value" in input) patch.value = text(input.value, "Field value", { max: 500 });
  const [updated] = await db.update(customFields).set(patch).where(eq(customFields.id, fieldId)).returning();
  await touchSpace(person.spaceId);
  return updated;
}

export async function deleteField(user: User, fieldId: string) {
  const { person } = await requireField(user, fieldId);
  await db.delete(customFields).where(eq(customFields.id, fieldId));
  await touchSpace(person.spaceId);
}

export async function reorderFields(user: User, personId: string, orderedIds: unknown) {
  await requirePerson(user, personId);
  if (!Array.isArray(orderedIds)) throw new HttpError(422, "Invalid order payload.");
  const owned = await db.select({ id: customFields.id }).from(customFields).where(eq(customFields.personId, personId));
  const ownedIds = new Set(owned.map((o) => o.id));
  let order = 0;
  for (const raw of orderedIds) {
    const id = String(raw);
    if (!ownedIds.has(id)) continue;
    await db.update(customFields).set({ sortOrder: order++ }).where(eq(customFields.id, id));
  }
}

/* ------------------------------------------------------------------ */
/* account "About Me" fields (same flexible concept, scoped to the user)*/
/* ------------------------------------------------------------------ */

export type UserFieldView = { id: string; label: string; value: string; sortOrder: number };

export async function listUserFields(user: User): Promise<UserFieldView[]> {
  const rows = await db
    .select()
    .from(userFields)
    .where(eq(userFields.userId, user.id))
    .orderBy(asc(userFields.sortOrder), asc(userFields.createdAt));
  return rows.map((f) => ({ id: f.id, label: f.label, value: f.value, sortOrder: f.sortOrder }));
}

export async function createUserField(user: User, input: Record<string, unknown>) {
  const label = text(input.label, "Field name", { max: 60, required: true });
  const value = text(input.value, "Field value", { max: 500 });
  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(user_fields.sort_order), -1)::int` })
    .from(userFields)
    .where(eq(userFields.userId, user.id));
  const [created] = await db
    .insert(userFields)
    .values({ userId: user.id, label, value, sortOrder: max + 1 })
    .returning();
  return created;
}

async function requireUserField(user: User, fieldId: string) {
  if (!isUuid(fieldId)) throw new HttpError(404, "Field not found.");
  const [row] = await db
    .select()
    .from(userFields)
    .where(and(eq(userFields.id, fieldId), eq(userFields.userId, user.id)))
    .limit(1);
  if (!row) throw new HttpError(404, "Field not found.");
  return row;
}

export async function updateUserField(user: User, fieldId: string, input: Record<string, unknown>) {
  await requireUserField(user, fieldId);
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if ("label" in input) patch.label = text(input.label, "Field name", { max: 60, required: true });
  if ("value" in input) patch.value = text(input.value, "Field value", { max: 500 });
  const [updated] = await db.update(userFields).set(patch).where(eq(userFields.id, fieldId)).returning();
  return updated;
}

export async function deleteUserField(user: User, fieldId: string) {
  await requireUserField(user, fieldId);
  await db.delete(userFields).where(eq(userFields.id, fieldId));
}

export async function reorderUserFields(user: User, orderedIds: unknown) {
  if (!Array.isArray(orderedIds)) throw new HttpError(422, "Invalid order payload.");
  const owned = await db.select({ id: userFields.id }).from(userFields).where(eq(userFields.userId, user.id));
  const ownedIds = new Set(owned.map((o) => o.id));
  let order = 0;
  for (const raw of orderedIds) {
    const id = String(raw);
    if (!ownedIds.has(id)) continue;
    await db.update(userFields).set({ sortOrder: order++ }).where(eq(userFields.id, id));
  }
}

/* ------------------------------------------------------------------ */
/* memories                                                            */
/* ------------------------------------------------------------------ */

export async function createMemory(user: User, personId: string, input: Record<string, unknown>) {
  const { person } = await requirePerson(user, personId);
  const title = text(input.title, "Title", { max: 120, required: true });
  const description = optionalText(input.description, "Description", 1200);
  const eventDate = text(input.eventDate, "Date", { max: 30, required: true });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) throw new HttpError(422, "Date must be YYYY-MM-DD.");
  const icon = text(input.icon, "Icon", { max: 8 }) || "✨";
  // Item 7: attachments reference owned media rows of the SAME person.
  // input.imageUrl is legacy-frozen and no longer accepted on write.
  const imageMediaId = await resolveMemoryAttachment(person.id, input.imageMediaId);
  const [created] = await db
    .insert(memories)
    .values({ personId, title, description, eventDate, icon, imageMediaId })
    .returning();
  await touchSpace(person.spaceId);
  return created;
}

/** Validates that an attachment id is a photo media row of the same person. */
async function resolveMemoryAttachment(personId: string, value: unknown): Promise<string | null> {
  if (value === undefined || value === null || value === "") return null;
  const id = String(value);
  if (!isUuid(id)) throw new HttpError(422, "Invalid attachment.");
  const [row] = await db
    .select({ id: media.id, kind: media.kind })
    .from(media)
    .where(and(eq(media.id, id), eq(media.personId, personId)))
    .limit(1);
  if (!row) throw new HttpError(422, "Attachments must be photos of this same person.");
  if (row.kind !== "photo") throw new HttpError(422, "Only photos can be attached to a memory.");
  return row.id;
}

export async function requireMemory(user: User, memoryId: string) {
  if (!isUuid(memoryId)) throw new HttpError(404, "Memory not found.");
  const [row] = await db
    .select({ memory: memories, person: people })
    .from(memories)
    .innerJoin(people, eq(people.id, memories.personId))
    .innerJoin(spaces, eq(spaces.id, people.spaceId))
    .where(and(eq(memories.id, memoryId), eq(spaces.userId, user.id)))
    .limit(1);
  if (!row) throw new HttpError(404, "Memory not found.");
  return row;
}

export async function updateMemory(user: User, memoryId: string, input: Record<string, unknown>) {
  const { person } = await requireMemory(user, memoryId);
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if ("title" in input) patch.title = text(input.title, "Title", { max: 120, required: true });
  if ("description" in input) patch.description = optionalText(input.description, "Description", 1200);
  if ("eventDate" in input) {
    const d = text(input.eventDate, "Date", { max: 30, required: true });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new HttpError(422, "Date must be YYYY-MM-DD.");
    patch.eventDate = d;
  }
  if ("icon" in input) patch.icon = text(input.icon, "Icon", { max: 8 }) || "✨";
  if ("imageMediaId" in input) {
    patch.imageMediaId = await resolveMemoryAttachment(person.id, input.imageMediaId);
  }
  const [updated] = await db.update(memories).set(patch).where(eq(memories.id, memoryId)).returning();
  await touchSpace(person.spaceId);
  return updated;
}

export async function deleteMemory(user: User, memoryId: string) {
  const { person } = await requireMemory(user, memoryId);
  await db.delete(memories).where(eq(memories.id, memoryId));
  await touchSpace(person.spaceId);
}

/* ------------------------------------------------------------------ */
/* media                                                               */
/* ------------------------------------------------------------------ */

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const ALLOWED_IMAGE = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const ALLOWED_DOC = ["application/pdf", "text/plain", "text/csv"];

type ValidatedUpload = {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  base64: string;
  kind: "photo" | "document";
};

/** Shared upload validation (RULE M2: binaries enter only through here). */
function validateUpload(
  input: Record<string, unknown>,
  opts: { imagesOnly?: boolean; maxBytes?: number } = {},
): ValidatedUpload {
  const fileName = text(input.fileName ?? "upload", "File name", { max: 160, required: true });
  const mimeType = text(input.mimeType, "File type", { max: 100, required: true });
  const dataUrl = typeof input.data === "string" ? input.data : "";
  const base64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
  if (!base64) throw new HttpError(422, "File contents missing.");
  const sizeBytes = Math.floor((base64.length * 3) / 4);
  const maxBytes = opts.maxBytes ?? MAX_UPLOAD_BYTES;
  if (sizeBytes > maxBytes) {
    throw new HttpError(422, `Files must be ${Math.round(maxBytes / 1024 / 1024)} MB or smaller.`);
  }
  const isImage = ALLOWED_IMAGE.includes(mimeType);
  if (opts.imagesOnly && !isImage) {
    throw new HttpError(422, "Only image files (JPG, PNG, WEBP, GIF) can be used here.");
  }
  if (!isImage && !ALLOWED_DOC.includes(mimeType)) {
    throw new HttpError(422, "Supported files: JPG, PNG, WEBP, GIF, PDF, TXT, CSV.");
  }
  return { fileName, mimeType, sizeBytes, base64, kind: isImage ? "photo" : "document" };
}

export async function createMedia(user: User, personId: string, input: Record<string, unknown>) {
  const { person } = await requirePerson(user, personId);
  const upload = validateUpload(input);
  const caption = optionalText(input.caption, "Caption", 200);
  const [created] = await db
    .insert(media)
    .values({
      personId,
      kind: upload.kind,
      fileName: upload.fileName,
      mimeType: upload.mimeType,
      sizeBytes: upload.sizeBytes,
      caption,
      data: upload.base64,
    })
    .returning();
  await touchSpace(person.spaceId);
  return created;
}

/**
 * Person avatar upload (item 8). Creates a gallery photo and points the
 * person's avatar at its private URL. RULE M1: readers see a plain avatarUrl.
 */
export async function uploadPersonAvatar(user: User, personId: string, input: Record<string, unknown>) {
  const { person } = await requirePerson(user, personId);
  const upload = validateUpload({ ...input, fileName: input.fileName ?? "Profile photo" }, { imagesOnly: true });
  const [row] = await db
    .insert(media)
    .values({
      personId,
      kind: "photo",
      fileName: upload.fileName,
      mimeType: upload.mimeType,
      sizeBytes: upload.sizeBytes,
      caption: "Profile photo",
      data: upload.base64,
    })
    .returning();
  await db
    .update(people)
    .set({ avatarUrl: `/api/media/${row.id}`, updatedAt: new Date() })
    .where(eq(people.id, personId));
  await touchSpace(person.spaceId);
  return row;
}

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/**
 * Account avatar upload (item 8). Binaries live on the account row — media rows
 * are person-scoped and are never repurposed for accounts. Empty `data` clears.
 */
export async function uploadAccountAvatar(user: User, input: Record<string, unknown>) {
  const dataRaw = typeof input.data === "string" ? input.data : "";
  if (!dataRaw) {
    const [cleared] = await db
      .update(users)
      .set({ avatarMime: null, avatarData: null, avatarUrl: null, updatedAt: new Date() })
      .where(eq(users.id, user.id))
      .returning();
    return cleared;
  }
  const upload = validateUpload(input, { imagesOnly: true, maxBytes: MAX_AVATAR_BYTES });
  const [updated] = await db
    .update(users)
    .set({
      avatarMime: upload.mimeType,
      avatarData: upload.base64,
      avatarUrl: "/api/account/avatar",
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id))
    .returning();
  return updated;
}

export async function requireMedia(user: User, mediaId: string) {
  if (!isUuid(mediaId)) throw new HttpError(404, "File not found.");
  const [row] = await db
    .select({ media, person: people })
    .from(media)
    .innerJoin(people, eq(people.id, media.personId))
    .innerJoin(spaces, eq(spaces.id, people.spaceId))
    .where(and(eq(media.id, mediaId), eq(spaces.userId, user.id)))
    .limit(1);
  if (!row) throw new HttpError(404, "File not found.");
  return row;
}

export async function deleteMedia(user: User, mediaId: string) {
  const row = await requireMedia(user, mediaId);
  await db.delete(media).where(eq(media.id, mediaId));
  await touchSpace(row.person.spaceId);
}

/* ------------------------------------------------------------------ */
/* cross-space aggregation + export                                    */
/* ------------------------------------------------------------------ */

export async function allConnections(user: User) {
  const rows = await db
    .select({ person: people, space: spaces })
    .from(people)
    .innerJoin(spaces, eq(spaces.id, people.spaceId))
    .where(and(eq(spaces.userId, user.id), eq(people.isMe, false)))
    .orderBy(asc(people.name));

  const counts = await db
    .select({
      personId: people.id,
      total: sql<number>`(
        select count(*)::int from relationships rc
        where rc.from_person_id = people.id or rc.to_person_id = people.id
      )`,
    })
    .from(people)
    .innerJoin(spaces, eq(spaces.id, people.spaceId))
    .where(eq(spaces.userId, user.id));
  const countMap = new Map(counts.map((c) => [c.personId, c.total]));
  const labels = await meLabelsForSpaces(
    user,
    [...new Set(rows.map((r) => r.space.id))],
  );

  return rows.map((r) => ({
    ...toPersonView(r.person, user, labels.get(r.person.id) ?? null),
    connectionCount: countMap.get(r.person.id) ?? 0,
    space: { id: r.space.id, name: r.space.name, icon: r.space.icon, color: r.space.color },
  }));
}

export type ConnectionRow = Awaited<ReturnType<typeof allConnections>>[number];

export async function exportData(user: User) {
  const spaceRows = await db.select().from(spaces).where(eq(spaces.userId, user.id));
  const spaceIds = spaceRows.map((s) => s.id);
  const peopleRows = spaceIds.length
    ? await db.select().from(people).where(inArray(people.spaceId, spaceIds))
    : [];
  const personIds = peopleRows.map((p) => p.id);
  const [edgeRows, fieldRows, memoryRows, mediaRows] = await Promise.all([
    spaceIds.length ? db.select().from(relationships).where(inArray(relationships.spaceId, spaceIds)) : [],
    personIds.length ? db.select().from(customFields).where(inArray(customFields.personId, personIds)) : [],
    personIds.length ? db.select().from(memories).where(inArray(memories.personId, personIds)) : [],
    personIds.length
      ? db
          .select({
            id: media.id,
            personId: media.personId,
            kind: media.kind,
            fileName: media.fileName,
            mimeType: media.mimeType,
            sizeBytes: media.sizeBytes,
            caption: media.caption,
          })
          .from(media)
          .where(inArray(media.personId, personIds))
      : [],
  ]);

  // RULE R1: export derives relationship labels from Me-edges, oldest first.
  const meIds = new Set(peopleRows.filter((p) => p.isMe).map((p) => p.id));
  const labels = new Map<string, string>();
  const sortedEdges = [...edgeRows].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1),
  );
  for (const e of sortedEdges) {
    const other = meIds.has(e.fromPersonId)
      ? e.toPersonId
      : meIds.has(e.toPersonId)
        ? e.fromPersonId
        : null;
    if (other && !labels.has(other)) labels.set(other, e.label);
  }

  return {
    exportedAt: new Date().toISOString(),
    format: "circlemap.export.v1",
    account: { email: user.email, displayName: user.displayName, bio: user.bio },
    spaces: spaceRows.map((s) => ({ id: s.id, name: s.name, description: s.description, icon: s.icon, color: s.color })),
    people: peopleRows.map((p) => ({
      id: p.id,
      spaceId: p.spaceId,
      name: p.isMe ? p.name ?? user.displayName : p.name,
      isMe: p.isMe,
      relationshipToMe: p.isMe ? "This is you" : (labels.get(p.id) ?? null),
      tags: p.tags,
    })),
    relationships: edgeRows.map((r) => ({
      id: r.id,
      spaceId: r.spaceId,
      from: r.fromPersonId,
      to: r.toPersonId,
      label: r.label,
      type: r.type,
    })),
    customFields: fieldRows.map((f) => ({ personId: f.personId, label: f.label, value: f.value })),
    memories: memoryRows.map((m) => ({
      personId: m.personId,
      title: m.title,
      description: m.description,
      eventDate: m.eventDate,
    })),
    mediaMetadata: mediaRows,
  };
}

export async function deleteAccount(user: User) {
  await db.delete(users).where(eq(users.id, user.id));
}

/* ------------------------------------------------------------------ */
/* search                                                              */
/* ------------------------------------------------------------------ */

export async function searchPeople(user: User, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const rows = await db
    .select({ person: people, space: spaces })
    .from(people)
    .innerJoin(spaces, eq(spaces.id, people.spaceId))
    .where(
      and(
        eq(spaces.userId, user.id),
        or(
          sql`lower(coalesce(people.name, '')) like ${"%" + q + "%"}`,
          sql`lower(people.tags::text) like ${"%" + q + "%"}`,
          sql`lower(spaces.name) like ${"%" + q + "%"}`,
          // RULE R1: relationship text is matched on Me-edges, not a stored column.
          sql`exists (
            select 1 from relationships r
            join people m on m.space_id = people.space_id and m.is_me = true
            where r.space_id = people.space_id
              and ((r.from_person_id = m.id and r.to_person_id = people.id)
                or (r.from_person_id = people.id and r.to_person_id = m.id))
              and lower(r.label) like ${"%" + q + "%"}
          )`,
        ),
      ),
    )
    .limit(50);
  const labels = await meLabelsForSpaces(
    user,
    [...new Set(rows.map((r) => r.space.id))],
  );
  return rows.map((r) => ({
    ...toPersonView(r.person, user, labels.get(r.person.id) ?? null),
    space: { id: r.space.id, name: r.space.name, icon: r.space.icon, color: r.space.color },
  }));
}
