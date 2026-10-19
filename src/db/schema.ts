import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * CircleMap schema (Phase 0.5 reconciled).
 *
 * Ownership chain (enforced in the data-access layer on every query):
 *   users -> spaces -> people -> (custom_fields | media | memories)
 *   relationships -> space + from_person + to_person (all same space, C5–C6)
 *   graph_layouts -> space + person + view_mode (pure visualization state, C7)
 *
 * Constraint catalogue (see ARCHITECTURE_RECONCILIATION.md item 12):
 *   C1  one Me per space (partial unique index)
 *   C2  valid relationship type (check)
 *   C3  valid view mode (check)
 *   C4  valid media kind (check)
 *   C5  edge from-endpoint in same space (composite FK)
 *   C6  edge to-endpoint in same space (composite FK)
 *   C7  layout row references same-space person (composite FK)
 *   C8  duplicate relationship key (unique index on from, to, lower(label))
 *   C9  no self-loops (check)
 *   C10 composite FK target (unique constraint on people(id, space_id))
 *   C11 memory attachment integrity (FK ... ON DELETE SET NULL)
 */

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  avatarUrl: text("avatar_url"),
  /** Uploaded account avatar bytes (base64). When present, avatarUrl is `/api/account/avatar`. */
  avatarMime: text("avatar_mime"),
  avatarData: text("avatar_data"),
  bio: text("bio"),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("users_email_unique").on(t.email)]);

/** Account-level "About Me" custom fields — mirrors custom_fields, scoped to the user. */
export const userFields = pgTable(
  "user_fields",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    value: text("value").notNull().default(""),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("user_fields_user_idx").on(t.userId)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("sessions_token_unique").on(t.token), index("sessions_user_idx").on(t.userId)],
);

export const spaces = pgTable(
  "spaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    icon: text("icon").notNull().default("🏠"),
    color: text("color").notNull().default("#6366F1"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("spaces_user_idx").on(t.userId)],
);

/**
 * A person inside a Space. The "Me" node (isMe) is the space-local representation
 * of the account: name/avatar are nullable overrides — when null the account value
 * is inherited at read time.
 *
 * NOTE (Phase 0.5, item 1): there is intentionally NO relationship_to_me column.
 * "How is X related to me" is derived from the oldest Me↔X edge (RULE R1).
 */
export const people = pgTable(
  "people",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    name: text("name"),
    avatarUrl: text("avatar_url"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    isMe: boolean("is_me").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("people_space_idx").on(t.spaceId),
    unique("people_id_space_uidx").on(t.id, t.spaceId), // C10: composite FK target
    uniqueIndex("people_one_me_per_space").on(t.spaceId).where(sql`${t.isMe} IS TRUE`), // C1
  ],
);

/**
 * relationshipType: "mutual" (unordered, canonically ordered) | "directional" (ordered).
 * See src/lib/relationships.ts for the exact semantics shared with the test suite.
 */
export const relationships = pgTable(
  "relationships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    fromPersonId: uuid("from_person_id").notNull(),
    toPersonId: uuid("to_person_id").notNull(),
    label: text("label").notNull(),
    type: text("type").notNull().default("mutual"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("relationships_space_idx").on(t.spaceId),
    index("relationships_from_idx").on(t.fromPersonId),
    index("relationships_to_idx").on(t.toPersonId),
    // C8: identity key (from, to, lower(label)). Mutual rows are stored in
    // canonical endpoint order (app RULE), so mirrors collide here too.
    uniqueIndex("relationships_pair_label_unique").on(
      t.fromPersonId,
      t.toPersonId,
      sql`lower(${t.label})`,
    ),
    // C5/C6: endpoints must live in the edge's own space.
    foreignKey({
      name: "relationships_from_space_fk",
      columns: [t.fromPersonId, t.spaceId],
      foreignColumns: [people.id, people.spaceId],
    }).onDelete("cascade"),
    foreignKey({
      name: "relationships_to_space_fk",
      columns: [t.toPersonId, t.spaceId],
      foreignColumns: [people.id, people.spaceId],
    }).onDelete("cascade"),
    check("relationships_type_check", sql`${t.type} IN ('mutual', 'directional')`), // C2
    check("relationships_no_self_loop", sql`${t.fromPersonId} <> ${t.toPersonId}`), // C9
  ],
);

export const customFields = pgTable(
  "custom_fields",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    value: text("value").notNull().default(""),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("custom_fields_person_idx").on(t.personId)],
);

/**
 * kind: "photo" | "document". Binary payload is private; served only via an authorized route.
 * storageKey is NULL for inline rows (data column authoritative) and set once a row lives in
 * object storage (item 11 migration seam) — readers prefer storageKey when present.
 */
export const media = pgTable(
  "media",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("photo"),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull().default(0),
    caption: text("caption"),
    /** base64 payload for uploads, or null when externalUrl is used (demo seed). */
    data: text("data"),
    externalUrl: text("external_url"),
    storageKey: text("storage_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("media_person_idx").on(t.personId),
    check("media_kind_check", sql`${t.kind} IN ('photo', 'document')`), // C4
  ],
);

export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    eventDate: text("event_date").notNull(),
    /** Legacy free-form image reference (read-only fallback). Source of truth is imageMediaId. */
    imageUrl: text("image_url"),
    /** Optional attachment: must reference a photo media row of the SAME person (item 7). */
    imageMediaId: uuid("image_media_id").references(() => media.id, { onDelete: "set null" }), // C11
    icon: text("icon").notNull().default("✨"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("memories_person_idx").on(t.personId)],
);

/** Pure visualization state. Never holds relationship semantics. viewMode: "circle" | "tree". */
export const graphLayouts = pgTable(
  "graph_layouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    personId: uuid("person_id").notNull(),
    viewMode: text("view_mode").notNull().default("circle"),
    x: real("x").notNull(),
    y: real("y").notNull(),
    pinned: boolean("pinned").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("graph_layouts_unique").on(t.spaceId, t.viewMode, t.personId),
    index("graph_layouts_space_idx").on(t.spaceId, t.viewMode),
    // C7: layout rows must reference a person of the same space.
    foreignKey({
      name: "graph_layouts_person_space_fk",
      columns: [t.personId, t.spaceId],
      foreignColumns: [people.id, people.spaceId],
    }).onDelete("cascade"),
    check("graph_layouts_view_mode_check", sql`${t.viewMode} IN ('circle', 'tree')`), // C3
  ],
);

/* ------------------------------------------------------------------ */
/* Backup restore staging (feature: full backup download + restore)    */
/* ------------------------------------------------------------------ */

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Temporary, user-scoped staging for chunked backup uploads.
 *
 * Deployed on Vercel a Function request body may not exceed 4.5 MB, so a large
 * backup file is uploaded as raw binary chunks and reassembled here before it is
 * validated. These rows are intentionally OUTSIDE the ownership chain that a full
 * restore deletes (users -> spaces -> ...), so an in-flight upload is never wiped
 * by the restore it is feeding. Rows expire and are swept on the next upload.
 */
export const backupUploads = pgTable(
  "backup_uploads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    totalBytes: integer("total_bytes").notNull(),
    totalChunks: integer("total_chunks").notNull(),
    chunkSize: integer("chunk_size").notNull(),
    receivedBytes: integer("received_bytes").notNull().default(0),
    /** pending -> validated -> consumed */
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("backup_uploads_user_idx").on(t.userId),
    index("backup_uploads_expires_idx").on(t.expiresAt),
    check("backup_uploads_status_check", sql`${t.status} IN ('pending', 'validated', 'consumed')`),
  ],
);

export const backupUploadChunks = pgTable(
  "backup_upload_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    uploadId: uuid("upload_id")
      .notNull()
      .references(() => backupUploads.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    data: bytea("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("backup_upload_chunks_unique").on(t.uploadId, t.chunkIndex)],
);

export type User = typeof users.$inferSelect;
export type UserField = typeof userFields.$inferSelect;
export type Space = typeof spaces.$inferSelect;
export type Person = typeof people.$inferSelect;
export type Relationship = typeof relationships.$inferSelect;
export type CustomField = typeof customFields.$inferSelect;
export type MediaRow = typeof media.$inferSelect;
export type Memory = typeof memories.$inferSelect;
export type GraphLayout = typeof graphLayouts.$inferSelect;
