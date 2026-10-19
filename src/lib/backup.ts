/**
 * Full backup (circlemap.backup.v2) serialization, validation and restore.
 *
 * Scope: this module ONLY powers the new "Download full backup" / "Restore point"
 * feature. The legacy `circlemap.export.v1` export in `exportData()` is untouched.
 *
 * Hosting note (Vercel): a Function request *or* response body may not exceed
 * 4.5 MB. The download is therefore produced as a streaming response (streaming
 * responses are not subject to the response-body limit) and the restore upload is
 * sent as raw binary chunks that each stay well below the request-body limit.
 */
import { createHash, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
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
import { canonicalPair, coerceType, coerceViewMode, keyLabel } from "@/lib/relationships";

export const BACKUP_FORMAT_V2 = "circlemap.backup.v2";
export const LEGACY_FORMAT_V1 = "circlemap.export.v1";

/** Hard ceiling for an accepted backup upload (staged in Postgres). */
export const MAX_BACKUP_BYTES = 200 * 1024 * 1024;
/** Each upload chunk must stay safely below the 4.5 MB Vercel request-body limit. */
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
export const DEFAULT_CHUNK_BYTES = 3 * 1024 * 1024;
/** Abandoned staging rows expire after this long and are swept lazily. */
export const UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* download — streamed serialization                                   */
/* ------------------------------------------------------------------ */

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export type BackupCounts = {
  spaces: number;
  people: number;
  meNodes: number;
  relationships: number;
  customFields: number;
  accountFields: number;
  memories: number;
  media: number;
  mediaWithPayload: number;
  externalMediaReferences: number;
  graphLayouts: number;
};

/**
 * Builds the backup as a stream of UTF-8 JSON fragments. Media payloads are read
 * one row at a time so a large backup never has to be buffered in full.
 */
export function streamBackup(user: User): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (s: string) => controller.enqueue(encoder.encode(s));
      try {
        const spaceRows = await db.select().from(spaces).where(eq(spaces.userId, user.id));
        const spaceIds = spaceRows.map((s) => s.id);
        const peopleRows = spaceIds.length
          ? await db.select().from(people).where(inArray(people.spaceId, spaceIds))
          : [];
        const personIds = peopleRows.map((p) => p.id);
        const [edgeRows, fieldRows, memoryRows, layoutRows, accountFieldRows] = await Promise.all([
          spaceIds.length
            ? db.select().from(relationships).where(inArray(relationships.spaceId, spaceIds))
            : [],
          personIds.length
            ? db.select().from(customFields).where(inArray(customFields.personId, personIds))
            : [],
          personIds.length
            ? db.select().from(memories).where(inArray(memories.personId, personIds))
            : [],
          spaceIds.length
            ? db.select().from(graphLayouts).where(inArray(graphLayouts.spaceId, spaceIds))
            : [],
          db.select().from(userFields).where(eq(userFields.userId, user.id)),
        ]);
        const mediaIndex = personIds.length
          ? await db
              .select({ id: media.id, personId: media.personId })
              .from(media)
              .where(inArray(media.personId, personIds))
          : [];

        write(`{\n"format":${JSON.stringify(BACKUP_FORMAT_V2)},\n"formatVersion":2,\n`);
        write(`"generator":"circlemap",\n"exportedAt":${JSON.stringify(new Date().toISOString())},\n`);
        write(
          `"sourceAccount":${JSON.stringify({
            email: user.email,
            note: "Informational only. A restore never changes the signed-in account identity.",
          })},\n`,
        );
        write(
          `"account":${JSON.stringify({
            displayName: user.displayName,
            bio: user.bio,
            avatarUrl: user.avatarUrl,
            avatarMime: user.avatarMime,
            avatarData: user.avatarData,
            avatarSha256: user.avatarData
              ? createHash("sha256").update(Buffer.from(user.avatarData, "base64")).digest("hex")
              : null,
            fields: accountFieldRows.map((f) => ({
              id: f.id,
              label: f.label,
              value: f.value,
              sortOrder: f.sortOrder,
              createdAt: iso(f.createdAt),
              updatedAt: iso(f.updatedAt),
            })),
          })},\n`,
        );
        write(
          `"spaces":${JSON.stringify(
            spaceRows.map((s) => ({
              id: s.id,
              name: s.name,
              description: s.description,
              icon: s.icon,
              color: s.color,
              createdAt: iso(s.createdAt),
              updatedAt: iso(s.updatedAt),
            })),
          )},\n`,
        );
        write(
          `"people":${JSON.stringify(
            peopleRows.map((p) => ({
              id: p.id,
              spaceId: p.spaceId,
              name: p.name,
              avatarUrl: p.avatarUrl,
              tags: p.tags,
              isMe: p.isMe,
              createdAt: iso(p.createdAt),
              updatedAt: iso(p.updatedAt),
            })),
          )},\n`,
        );
        write(
          `"relationships":${JSON.stringify(
            edgeRows.map((r) => ({
              id: r.id,
              spaceId: r.spaceId,
              fromPersonId: r.fromPersonId,
              toPersonId: r.toPersonId,
              label: r.label,
              type: r.type,
              note: r.note,
              createdAt: iso(r.createdAt),
              updatedAt: iso(r.updatedAt),
            })),
          )},\n`,
        );
        write(
          `"customFields":${JSON.stringify(
            fieldRows.map((f) => ({
              id: f.id,
              personId: f.personId,
              label: f.label,
              value: f.value,
              sortOrder: f.sortOrder,
              createdAt: iso(f.createdAt),
              updatedAt: iso(f.updatedAt),
            })),
          )},\n`,
        );
        write(
          `"memories":${JSON.stringify(
            memoryRows.map((m) => ({
              id: m.id,
              personId: m.personId,
              title: m.title,
              description: m.description,
              eventDate: m.eventDate,
              imageUrl: m.imageUrl,
              imageMediaId: m.imageMediaId,
              icon: m.icon,
              createdAt: iso(m.createdAt),
              updatedAt: iso(m.updatedAt),
            })),
          )},\n`,
        );
        write(
          `"graphLayouts":${JSON.stringify(
            layoutRows.map((l) => ({
              id: l.id,
              spaceId: l.spaceId,
              personId: l.personId,
              viewMode: l.viewMode,
              x: l.x,
              y: l.y,
              pinned: l.pinned,
              updatedAt: iso(l.updatedAt),
            })),
          )},\n`,
        );

        // Media payloads: streamed row by row so memory stays bounded.
        write(`"media":[`);
        let withPayload = 0;
        let externalRefs = 0;
        let totalMediaBytes = 0;
        for (let i = 0; i < mediaIndex.length; i += 1) {
          const [row] = await db.select().from(media).where(eq(media.id, mediaIndex[i].id)).limit(1);
          if (!row) continue;
          const buf = row.data ? Buffer.from(row.data, "base64") : null;
          if (buf) {
            withPayload += 1;
            totalMediaBytes += buf.length;
          } else if (row.externalUrl) {
            externalRefs += 1;
          }
          const entry = {
            id: row.id,
            personId: row.personId,
            kind: row.kind,
            fileName: row.fileName,
            mimeType: row.mimeType,
            sizeBytes: row.sizeBytes,
            caption: row.caption,
            storageKey: row.storageKey,
            createdAt: iso(row.createdAt),
            content: buf
              ? {
                  encoding: "base64" as const,
                  bytes: buf.length,
                  sha256: createHash("sha256").update(buf).digest("hex"),
                  data: row.data,
                }
              : null,
            externalReference: !buf && row.externalUrl
              ? {
                  url: row.externalUrl,
                  // Truthful: CircleMap never stored these bytes, so they are not in the backup.
                  binaryIncluded: false,
                }
              : null,
          };
          write((i === 0 ? "" : ",") + JSON.stringify(entry));
        }
        write(`],\n`);

        const counts: BackupCounts = {
          spaces: spaceRows.length,
          people: peopleRows.length,
          meNodes: peopleRows.filter((p) => p.isMe).length,
          relationships: edgeRows.length,
          customFields: fieldRows.length,
          accountFields: accountFieldRows.length,
          memories: memoryRows.length,
          media: mediaIndex.length,
          mediaWithPayload: withPayload,
          externalMediaReferences: externalRefs,
          graphLayouts: layoutRows.length,
        };
        write(`"integrity":${JSON.stringify({ counts, totalMediaBytes })}\n}\n`);
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

/* ------------------------------------------------------------------ */
/* validation                                                          */
/* ------------------------------------------------------------------ */

export type RestoreFormat = "circlemap.backup.v2" | "circlemap.export.v1";

export type BackupPreview = {
  format: RestoreFormat;
  formatLabel: string;
  legacy: boolean;
  exportedAt: string | null;
  sourceEmail: string | null;
  counts: {
    spaces: number;
    people: number;
    meNodes: number;
    relationships: number;
    mutualRelationships: number;
    directionalRelationships: number;
    customFields: number;
    accountFields: number;
    memories: number;
    media: number;
    mediaWithPayload: number;
    externalMediaReferences: number;
    graphLayouts: number;
  };
  mediaBytes: number;
  warnings: string[];
  notRecoverable: string[];
  destructive: boolean;
};

export type ValidationResult =
  | { ok: true; preview: BackupPreview; data: ParsedBackup }
  | { ok: false; errors: string[] };

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export type ParsedBackup =
  | { kind: "v2"; raw: Obj }
  | { kind: "v1"; raw: Obj };

export function detectFormat(raw: unknown): RestoreFormat | null {
  if (!isObj(raw)) return null;
  const format = str(raw.format);
  if (format === BACKUP_FORMAT_V2) return BACKUP_FORMAT_V2;
  if (format === LEGACY_FORMAT_V1) return LEGACY_FORMAT_V1;
  return null;
}

export function parseBackupText(text: string): Obj {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(422, "That file is not valid JSON — it may be corrupted or incomplete.");
  }
  if (!isObj(parsed)) {
    throw new HttpError(422, "That file does not look like a CircleMap backup.");
  }
  return parsed;
}

/** Validates a circlemap.backup.v2 document end-to-end (structure, references, media). */
export function validateBackupV2(raw: Obj): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (str(raw.format) !== BACKUP_FORMAT_V2) {
    return { ok: false, errors: ["Unsupported backup format."] };
  }
  for (const key of ["spaces", "people", "relationships", "customFields", "memories", "media", "graphLayouts"]) {
    if (!Array.isArray(raw[key])) errors.push(`Backup is missing the "${key}" section.`);
  }
  if (!isObj(raw.account)) errors.push('Backup is missing the "account" section.');
  if (errors.length) return { ok: false, errors };

  const spaceRows = arr(raw.spaces).filter(isObj);
  const peopleRows = arr(raw.people).filter(isObj);
  const edgeRows = arr(raw.relationships).filter(isObj);
  const fieldRows = arr(raw.customFields).filter(isObj);
  const memoryRows = arr(raw.memories).filter(isObj);
  const mediaRows = arr(raw.media).filter(isObj);
  const layoutRows = arr(raw.graphLayouts).filter(isObj);
  const account = isObj(raw.account) ? raw.account : {};
  const accountFieldRows = arr(account.fields).filter(isObj);

  const spaceIds = new Set<string>();
  for (const s of spaceRows) {
    const id = str(s.id);
    if (!id) errors.push("A Space in the backup has no id.");
    else if (spaceIds.has(id)) errors.push(`Duplicate Space id ${id}.`);
    else spaceIds.add(id);
    if (!str(s.name)) errors.push(`Space ${id ?? "?"} has no name.`);
  }

  const personSpace = new Map<string, string>();
  const meBySpace = new Map<string, number>();
  for (const p of peopleRows) {
    const id = str(p.id);
    const spaceId = str(p.spaceId);
    if (!id) {
      errors.push("A person in the backup has no id.");
      continue;
    }
    if (personSpace.has(id)) errors.push(`Duplicate person id ${id}.`);
    if (!spaceId || !spaceIds.has(spaceId)) {
      // Cross-space / cross-user reference: refuse rather than silently re-home it.
      errors.push(`Person ${id} references a Space that is not in this backup.`);
      continue;
    }
    personSpace.set(id, spaceId);
    if (p.isMe === true) {
      const n = (meBySpace.get(spaceId) ?? 0) + 1;
      meBySpace.set(spaceId, n);
      if (n > 1) errors.push(`Space ${spaceId} has more than one "Me" node.`);
    }
  }

  let mutual = 0;
  let directional = 0;
  const edgeKeys = new Set<string>();
  for (const r of edgeRows) {
    const from = str(r.fromPersonId);
    const to = str(r.toPersonId);
    const spaceId = str(r.spaceId);
    const label = str(r.label);
    const type = coerceType(r.type);
    if (!from || !to || !label) {
      errors.push("A relationship in the backup is missing endpoints or a label.");
      continue;
    }
    if (from === to) {
      errors.push(`Relationship ${str(r.id) ?? ""} points a person at themselves.`);
      continue;
    }
    const fromSpace = personSpace.get(from);
    const toSpace = personSpace.get(to);
    if (!fromSpace || !toSpace) {
      errors.push("A relationship references a person that is not in this backup.");
      continue;
    }
    if (fromSpace !== toSpace || (spaceId && spaceId !== fromSpace)) {
      errors.push("A relationship crosses Spaces, which CircleMap does not allow.");
      continue;
    }
    const [a, b] = canonicalPair(from, to, type);
    const key = `${a}|${b}|${keyLabel(label)}`;
    if (edgeKeys.has(key)) {
      warnings.push("Duplicate relationships were found and will be de-duplicated on restore.");
    } else {
      edgeKeys.add(key);
    }
    if (type === "mutual") mutual += 1;
    else directional += 1;
  }

  for (const f of fieldRows) {
    if (!personSpace.has(str(f.personId) ?? "")) {
      errors.push("A custom field references a person that is not in this backup.");
      break;
    }
  }

  let withPayload = 0;
  let externalRefs = 0;
  let mediaBytes = 0;
  const mediaPerson = new Map<string, string>();
  for (const m of mediaRows) {
    const id = str(m.id);
    const personId = str(m.personId);
    if (!id || !personId || !personSpace.has(personId)) {
      errors.push("A media file references a person that is not in this backup.");
      continue;
    }
    mediaPerson.set(id, personId);
    const content = isObj(m.content) ? m.content : null;
    const external = isObj(m.externalReference) ? m.externalReference : null;
    if (content) {
      const data = str(content.data);
      if (!data) {
        errors.push(`Media "${str(m.fileName) ?? id}" has no file contents.`);
        continue;
      }
      const buf = Buffer.from(data, "base64");
      if (buf.length === 0) {
        errors.push(`Media "${str(m.fileName) ?? id}" has an empty payload.`);
        continue;
      }
      const declared = num(content.bytes);
      if (declared !== null && declared !== buf.length) {
        errors.push(`Media "${str(m.fileName) ?? id}" has a size that does not match its contents.`);
        continue;
      }
      const sha = str(content.sha256);
      if (sha && createHash("sha256").update(buf).digest("hex") !== sha) {
        errors.push(`Media "${str(m.fileName) ?? id}" failed its checksum — the file is corrupted.`);
        continue;
      }
      withPayload += 1;
      mediaBytes += buf.length;
    } else if (external) {
      externalRefs += 1;
      warnings.push(
        "Some media rows are external references whose bytes CircleMap never stored; only the link is restored.",
      );
    } else {
      errors.push(`Media "${str(m.fileName) ?? id}" contains neither file contents nor an external reference.`);
    }
  }

  for (const m of memoryRows) {
    if (!personSpace.has(str(m.personId) ?? "")) {
      errors.push("A memory references a person that is not in this backup.");
      break;
    }
  }
  for (const m of memoryRows) {
    const attachment = str(m.imageMediaId);
    if (attachment && mediaPerson.get(attachment) !== str(m.personId)) {
      warnings.push("A memory attachment pointed at another person's file and will be detached.");
      break;
    }
  }

  for (const l of layoutRows) {
    const spaceId = str(l.spaceId);
    const personId = str(l.personId);
    if (!spaceId || !spaceIds.has(spaceId) || !personId || personSpace.get(personId) !== spaceId) {
      errors.push("A graph layout references a person outside its own Space.");
      break;
    }
    if (num(l.x) === null || num(l.y) === null) {
      errors.push("A graph layout has invalid coordinates.");
      break;
    }
  }

  if (errors.length) return { ok: false, errors: [...new Set(errors)].slice(0, 20) };

  const declared = isObj(raw.integrity) && isObj(raw.integrity.counts) ? raw.integrity.counts : null;
  if (declared && num(declared.people) !== null && num(declared.people) !== peopleRows.length) {
    warnings.push("The backup's declared record counts do not match its contents.");
  }

  const preview: BackupPreview = {
    format: BACKUP_FORMAT_V2,
    formatLabel: "Full backup (circlemap.backup.v2)",
    legacy: false,
    exportedAt: str(raw.exportedAt),
    sourceEmail: isObj(raw.sourceAccount) ? str(raw.sourceAccount.email) : null,
    counts: {
      spaces: spaceRows.length,
      people: peopleRows.length,
      meNodes: peopleRows.filter((p) => p.isMe === true).length,
      relationships: edgeRows.length,
      mutualRelationships: mutual,
      directionalRelationships: directional,
      customFields: fieldRows.length,
      accountFields: accountFieldRows.length,
      memories: memoryRows.length,
      media: mediaRows.length,
      mediaWithPayload: withPayload,
      externalMediaReferences: externalRefs,
      graphLayouts: layoutRows.length,
    },
    mediaBytes,
    warnings: [...new Set(warnings)],
    notRecoverable: externalRefs
      ? ["Externally linked media (their bytes were never stored by CircleMap — the link is kept)."]
      : [],
    destructive: true,
  };
  return { ok: true, preview, data: { kind: "v2", raw } };
}

/** Summarizes a legacy circlemap.export.v1 document and states what it never contained. */
export function validateLegacyV1(raw: Obj): ValidationResult {
  const errors: string[] = [];
  if (str(raw.format) !== LEGACY_FORMAT_V1) {
    return { ok: false, errors: ["Unsupported backup format."] };
  }
  for (const key of ["spaces", "people", "relationships"]) {
    if (!Array.isArray(raw[key])) errors.push(`Export is missing the "${key}" section.`);
  }
  if (errors.length) return { ok: false, errors };

  const spaceRows = arr(raw.spaces).filter(isObj);
  const peopleRows = arr(raw.people).filter(isObj);
  const edgeRows = arr(raw.relationships).filter(isObj);
  const fieldRows = arr(raw.customFields).filter(isObj);
  const memoryRows = arr(raw.memories).filter(isObj);
  const mediaMeta = arr(raw.mediaMetadata).filter(isObj);

  const spaceIds = new Set(spaceRows.map((s) => str(s.id)).filter((v): v is string => !!v));
  if (spaceIds.size !== spaceRows.length) errors.push("The export contains duplicate Space ids.");
  const personSpace = new Map<string, string>();
  for (const p of peopleRows) {
    const id = str(p.id);
    const spaceId = str(p.spaceId);
    if (!id || !spaceId || !spaceIds.has(spaceId)) continue;
    personSpace.set(id, spaceId);
  }
  if (!spaceRows.length && !peopleRows.length) {
    errors.push("This export contains no Spaces or people to import.");
  }
  if (errors.length) return { ok: false, errors };

  let mutual = 0;
  let directional = 0;
  for (const r of edgeRows) {
    if (coerceType(r.type) === "mutual") mutual += 1;
    else directional += 1;
  }

  const preview: BackupPreview = {
    format: LEGACY_FORMAT_V1,
    formatLabel: "Legacy partial export (circlemap.export.v1)",
    legacy: true,
    exportedAt: str(raw.exportedAt),
    sourceEmail: isObj(raw.account) ? str(raw.account.email) : null,
    counts: {
      spaces: spaceRows.length,
      people: peopleRows.length,
      meNodes: peopleRows.filter((p) => p.isMe === true).length,
      relationships: edgeRows.length,
      mutualRelationships: mutual,
      directionalRelationships: directional,
      customFields: fieldRows.length,
      accountFields: 0,
      memories: memoryRows.length,
      media: 0,
      mediaWithPayload: 0,
      externalMediaReferences: 0,
      graphLayouts: 0,
    },
    mediaBytes: 0,
    warnings: [
      "This is the older, partial JSON export. It can only restore what it actually contains.",
      "It will be imported alongside your current data — nothing existing is deleted.",
    ],
    notRecoverable: [
      `Uploaded photos and documents (${mediaMeta.length} file${mediaMeta.length === 1 ? "" : "s"} listed as metadata only — no file contents were ever exported).`,
      "Your account avatar image bytes.",
      "Account-level About Me fields.",
      "Circle and Tree graph layout positions.",
      "Person avatars, tags ordering metadata, relationship notes and memory attachments.",
    ],
    destructive: false,
  };
  return { ok: true, preview, data: { kind: "v1", raw } };
}

export function validateBackupDocument(raw: Obj): ValidationResult {
  const format = detectFormat(raw);
  if (format === BACKUP_FORMAT_V2) return validateBackupV2(raw);
  if (format === LEGACY_FORMAT_V1) return validateLegacyV1(raw);
  return {
    ok: false,
    errors: [
      "Unrecognised file. Choose a CircleMap backup (circlemap.backup.v2) or export (circlemap.export.v1) JSON file.",
    ],
  };
}

/* ------------------------------------------------------------------ */
/* restore                                                             */
/* ------------------------------------------------------------------ */

export type RestoreResult = {
  format: RestoreFormat;
  mode: "replace" | "merge";
  restored: Record<string, number>;
  skipped: string[];
  notRecoverable: string[];
};

const chunked = <T,>(rows: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
};

const date = (v: unknown): Date | undefined => {
  const s = str(v);
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

/**
 * Full restore. Replaces ONLY the authenticated user's owned application data and
 * never touches users.id / email / password_hash / sessions. All work happens in a
 * single transaction, so a failure rolls back to the pre-restore state.
 */
export async function restoreFullBackup(user: User, raw: Obj): Promise<RestoreResult> {
  const check = validateBackupV2(raw);
  if (!check.ok) throw new HttpError(422, check.errors[0] ?? "This backup is not valid.");

  const account = isObj(raw.account) ? raw.account : {};
  const spaceRows = arr(raw.spaces).filter(isObj);
  const peopleRows = arr(raw.people).filter(isObj);
  const edgeRows = arr(raw.relationships).filter(isObj);
  const fieldRows = arr(raw.customFields).filter(isObj);
  const memoryRows = arr(raw.memories).filter(isObj);
  const mediaRows = arr(raw.media).filter(isObj);
  const layoutRows = arr(raw.graphLayouts).filter(isObj);
  const accountFieldRows = arr(account.fields).filter(isObj);

  const spaceMap = new Map<string, string>();
  const personMap = new Map<string, string>();
  const mediaMap = new Map<string, string>();
  for (const s of spaceRows) spaceMap.set(str(s.id)!, randomUUID());
  for (const p of peopleRows) personMap.set(str(p.id)!, randomUUID());
  for (const m of mediaRows) mediaMap.set(str(m.id)!, randomUUID());

  const skipped: string[] = [];
  const restored: Record<string, number> = {};

  await db.transaction(async (tx) => {
    // 1. Replace only this user's application data (cascades to people/media/...).
    await tx.delete(spaces).where(eq(spaces.userId, user.id));
    await tx.delete(userFields).where(eq(userFields.userId, user.id));

    // 2. Account profile — identity columns (id/email/password_hash) are never touched.
    await tx
      .update(users)
      .set({
        displayName: str(account.displayName) || user.displayName,
        bio: str(account.bio),
        avatarUrl: str(account.avatarUrl),
        avatarMime: str(account.avatarMime),
        avatarData: str(account.avatarData),
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    if (accountFieldRows.length) {
      await tx.insert(userFields).values(
        accountFieldRows.map((f, i) => ({
          id: randomUUID(),
          userId: user.id,
          label: str(f.label) ?? "Field",
          value: str(f.value) ?? "",
          sortOrder: num(f.sortOrder) ?? i,
          createdAt: date(f.createdAt),
          updatedAt: date(f.updatedAt),
        })),
      );
    }
    restored.accountFields = accountFieldRows.length;

    if (spaceRows.length) {
      await tx.insert(spaces).values(
        spaceRows.map((s) => ({
          id: spaceMap.get(str(s.id)!)!,
          userId: user.id,
          name: str(s.name) ?? "Space",
          description: str(s.description),
          icon: str(s.icon) ?? "🏠",
          color: str(s.color) ?? "#6366F1",
          createdAt: date(s.createdAt),
          updatedAt: date(s.updatedAt),
        })),
      );
    }
    restored.spaces = spaceRows.length;

    for (const batch of chunked(peopleRows, 500)) {
      await tx.insert(people).values(
        batch.map((p) => ({
          id: personMap.get(str(p.id)!)!,
          spaceId: spaceMap.get(str(p.spaceId)!)!,
          name: str(p.name),
          avatarUrl: str(p.avatarUrl),
          tags: Array.isArray(p.tags) ? (p.tags.filter((t) => typeof t === "string") as string[]) : [],
          isMe: p.isMe === true,
          createdAt: date(p.createdAt),
          updatedAt: date(p.updatedAt),
        })),
      );
    }
    restored.people = peopleRows.length;

    const seenEdge = new Set<string>();
    const edgeValues: Array<typeof relationships.$inferInsert> = [];
    for (const r of edgeRows) {
      const type = coerceType(r.type);
      const from = personMap.get(str(r.fromPersonId)!);
      const to = personMap.get(str(r.toPersonId)!);
      const label = (str(r.label) ?? "").trim();
      if (!from || !to || !label) continue;
      const [a, b] = canonicalPair(from, to, type);
      const key = `${a}|${b}|${keyLabel(label)}`;
      if (seenEdge.has(key)) {
        skipped.push(`Duplicate relationship "${label}" skipped.`);
        continue;
      }
      seenEdge.add(key);
      edgeValues.push({
        id: randomUUID(),
        spaceId: spaceMap.get(str(r.spaceId)!)!,
        fromPersonId: a,
        toPersonId: b,
        label,
        type,
        note: str(r.note),
        createdAt: date(r.createdAt),
        updatedAt: date(r.updatedAt),
      });
    }
    for (const batch of chunked(edgeValues, 500)) await tx.insert(relationships).values(batch);
    restored.relationships = edgeValues.length;

    for (const batch of chunked(fieldRows, 500)) {
      await tx.insert(customFields).values(
        batch.map((f, i) => ({
          id: randomUUID(),
          personId: personMap.get(str(f.personId)!)!,
          label: str(f.label) ?? "Field",
          value: str(f.value) ?? "",
          sortOrder: num(f.sortOrder) ?? i,
          createdAt: date(f.createdAt),
          updatedAt: date(f.updatedAt),
        })),
      );
    }
    restored.customFields = fieldRows.length;

    let mediaCount = 0;
    for (const batch of chunked(mediaRows, 25)) {
      const values = batch.map((m) => {
        const content = isObj(m.content) ? m.content : null;
        const external = isObj(m.externalReference) ? m.externalReference : null;
        const data = content ? str(content.data) : null;
        const bytes = data ? Buffer.from(data, "base64").length : 0;
        return {
          id: mediaMap.get(str(m.id)!)!,
          personId: personMap.get(str(m.personId)!)!,
          kind: m.kind === "document" ? "document" : "photo",
          fileName: str(m.fileName) ?? "file",
          mimeType: str(m.mimeType) ?? "application/octet-stream",
          sizeBytes: data ? bytes : (num(m.sizeBytes) ?? 0),
          caption: str(m.caption),
          data,
          externalUrl: external ? str(external.url) : null,
          storageKey: str(m.storageKey),
          createdAt: date(m.createdAt),
        };
      });
      if (values.length) await tx.insert(media).values(values);
      mediaCount += values.length;
    }
    restored.media = mediaCount;

    let memoryCount = 0;
    for (const batch of chunked(memoryRows, 500)) {
      const values = batch.map((m) => {
        const attachment = str(m.imageMediaId);
        const mappedAttachment = attachment ? (mediaMap.get(attachment) ?? null) : null;
        if (attachment && !mappedAttachment) {
          skipped.push(`Memory "${str(m.title) ?? ""}" lost an attachment that was not in the backup.`);
        }
        return {
          id: randomUUID(),
          personId: personMap.get(str(m.personId)!)!,
          title: str(m.title) ?? "Memory",
          description: str(m.description),
          eventDate: str(m.eventDate) ?? new Date().toISOString().slice(0, 10),
          imageUrl: str(m.imageUrl),
          imageMediaId: mappedAttachment,
          icon: str(m.icon) ?? "✨",
          createdAt: date(m.createdAt),
          updatedAt: date(m.updatedAt),
        };
      });
      if (values.length) await tx.insert(memories).values(values);
      memoryCount += values.length;
    }
    restored.memories = memoryCount;

    const seenLayout = new Set<string>();
    const layoutValues: Array<typeof graphLayouts.$inferInsert> = [];
    for (const l of layoutRows) {
      const spaceId = spaceMap.get(str(l.spaceId)!);
      const personId = personMap.get(str(l.personId)!);
      if (!spaceId || !personId) continue;
      const viewMode = coerceViewMode(l.viewMode);
      const key = `${spaceId}|${viewMode}|${personId}`;
      if (seenLayout.has(key)) continue;
      seenLayout.add(key);
      layoutValues.push({
        id: randomUUID(),
        spaceId,
        personId,
        viewMode,
        x: num(l.x) ?? 0,
        y: num(l.y) ?? 0,
        pinned: l.pinned !== false,
        updatedAt: date(l.updatedAt),
      });
    }
    for (const batch of chunked(layoutValues, 500)) await tx.insert(graphLayouts).values(batch);
    restored.graphLayouts = layoutValues.length;
  });

  return {
    format: BACKUP_FORMAT_V2,
    mode: "replace",
    restored,
    skipped: [...new Set(skipped)].slice(0, 20),
    notRecoverable: check.preview.notRecoverable,
  };
}

/**
 * Legacy (circlemap.export.v1) import. Non-destructive: existing content is kept and
 * the exported records are added with fresh ids and remapped references.
 */
export async function importLegacyExport(user: User, raw: Obj): Promise<RestoreResult> {
  const check = validateLegacyV1(raw);
  if (!check.ok) throw new HttpError(422, check.errors[0] ?? "This export is not valid.");

  const spaceRows = arr(raw.spaces).filter(isObj);
  const peopleRows = arr(raw.people).filter(isObj);
  const edgeRows = arr(raw.relationships).filter(isObj);
  const fieldRows = arr(raw.customFields).filter(isObj);
  const memoryRows = arr(raw.memories).filter(isObj);
  const mediaMeta = arr(raw.mediaMetadata).filter(isObj);

  const skipped: string[] = [];
  const restored: Record<string, number> = {};

  const spaceMap = new Map<string, string>();
  for (const s of spaceRows) {
    const id = str(s.id);
    if (id) spaceMap.set(id, randomUUID());
  }
  const personMap = new Map<string, string>();
  const personSpace = new Map<string, string>();
  const meTaken = new Set<string>();

  await db.transaction(async (tx) => {
    if (spaceRows.length) {
      await tx.insert(spaces).values(
        spaceRows.map((s) => ({
          id: spaceMap.get(str(s.id)!)!,
          userId: user.id,
          name: str(s.name) ?? "Imported space",
          description: str(s.description),
          icon: str(s.icon) ?? "🏠",
          color: str(s.color) ?? "#6366F1",
        })),
      );
    }
    restored.spaces = spaceRows.length;

    const personValues: Array<typeof people.$inferInsert> = [];
    for (const p of peopleRows) {
      const oldId = str(p.id);
      const spaceId = oldId ? spaceMap.get(str(p.spaceId) ?? "") : undefined;
      if (!oldId || !spaceId) {
        skipped.push("A person referenced a Space that was not in the export and was not imported.");
        continue;
      }
      let isMe = p.isMe === true;
      if (isMe && meTaken.has(spaceId)) {
        isMe = false;
        skipped.push('A Space contained more than one "Me" node; extras were imported as ordinary people.');
      }
      if (isMe) meTaken.add(spaceId);
      const newId = randomUUID();
      personMap.set(oldId, newId);
      personSpace.set(oldId, spaceId);
      personValues.push({
        id: newId,
        spaceId,
        name: str(p.name),
        tags: Array.isArray(p.tags) ? (p.tags.filter((t) => typeof t === "string") as string[]) : [],
        isMe,
      });
    }
    for (const batch of chunked(personValues, 500)) await tx.insert(people).values(batch);
    restored.people = personValues.length;

    const seenEdge = new Set<string>();
    const edgeValues: Array<typeof relationships.$inferInsert> = [];
    for (const r of edgeRows) {
      const fromOld = str(r.from) ?? str(r.fromPersonId);
      const toOld = str(r.to) ?? str(r.toPersonId);
      const label = (str(r.label) ?? "").trim();
      const from = fromOld ? personMap.get(fromOld) : undefined;
      const to = toOld ? personMap.get(toOld) : undefined;
      if (!from || !to || !label || from === to) {
        skipped.push("A relationship could not be imported because an endpoint was missing.");
        continue;
      }
      if (personSpace.get(fromOld!) !== personSpace.get(toOld!)) {
        skipped.push("A relationship crossed Spaces and was not imported.");
        continue;
      }
      const type = coerceType(r.type);
      const [a, b] = canonicalPair(from, to, type);
      const key = `${a}|${b}|${keyLabel(label)}`;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      edgeValues.push({
        id: randomUUID(),
        spaceId: personSpace.get(fromOld!)!,
        fromPersonId: a,
        toPersonId: b,
        label,
        type,
      });
    }
    for (const batch of chunked(edgeValues, 500)) await tx.insert(relationships).values(batch);
    restored.relationships = edgeValues.length;

    const fieldValues = fieldRows
      .map((f, i) => {
        const personId = personMap.get(str(f.personId) ?? "");
        if (!personId) return null;
        return {
          id: randomUUID(),
          personId,
          label: str(f.label) ?? "Field",
          value: str(f.value) ?? "",
          sortOrder: num(f.sortOrder) ?? i,
        };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);
    if (fieldValues.length < fieldRows.length) {
      skipped.push("Some custom fields referenced a person that was not in the export.");
    }
    for (const batch of chunked(fieldValues, 500)) await tx.insert(customFields).values(batch);
    restored.customFields = fieldValues.length;

    const memoryValues = memoryRows
      .map((m) => {
        const personId = personMap.get(str(m.personId) ?? "");
        if (!personId) return null;
        return {
          id: randomUUID(),
          personId,
          title: str(m.title) ?? "Memory",
          description: str(m.description),
          eventDate: str(m.eventDate) ?? new Date().toISOString().slice(0, 10),
        };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);
    if (memoryValues.length < memoryRows.length) {
      skipped.push("Some memories referenced a person that was not in the export.");
    }
    for (const batch of chunked(memoryValues, 500)) await tx.insert(memories).values(batch);
    restored.memories = memoryValues.length;

    // Media is intentionally NOT recreated: v1 only carried metadata, and a media row
    // without bytes would be a broken file in the UI.
    restored.media = 0;
    restored.graphLayouts = 0;
    restored.accountFields = 0;
  });

  if (mediaMeta.length) {
    skipped.push(
      `${mediaMeta.length} uploaded file${mediaMeta.length === 1 ? " was" : "s were"} listed in the export as metadata only — no file contents exist to restore, so no media records were created.`,
    );
  }

  return {
    format: LEGACY_FORMAT_V1,
    mode: "merge",
    restored,
    skipped: [...new Set(skipped)].slice(0, 20),
    notRecoverable: check.preview.notRecoverable,
  };
}
