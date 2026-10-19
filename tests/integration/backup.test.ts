/**
 * Integration tests for the full backup download and the restore point.
 *
 * Requires a running server:
 *   TEST_BASE_URL=http://localhost:3000 npx tsx --test tests/integration/backup.test.ts
 *
 * Creates uniquely-named QA users and deletes them afterwards.
 */
import "dotenv/config";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../../src/db/index";
import { backupUploadChunks, backupUploads, sessions, spaces, users } from "../../src/db/schema";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const RUN = Date.now().toString(36);
const emailSrc = `backup-src-${RUN}@example.com`;
const emailDst = `backup-dst-${RUN}@example.com`;
const emailLegacy = `backup-legacy-${RUN}@example.com`;
const PW = "password123";

type Jar = { cookie: string };
const src: Jar = { cookie: "" };
const dst: Jar = { cookie: "" };
const legacyJar: Jar = { cookie: "" };

async function api(jar: Jar | null, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (jar?.cookie) headers.set("Cookie", jar.cookie);
  const res = await fetch(BASE + path, { ...init, headers });
  const getSetCookie = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  for (const c of getSetCookie?.call(res.headers) ?? []) {
    const pair = c.split(";")[0].trim();
    if (!jar) continue;
    if (pair.startsWith("cm_session=")) jar.cookie = pair;
  }
  const textBody = await res.text();
  let body: unknown = null;
  try {
    body = textBody ? JSON.parse(textBody) : null;
  } catch {
    body = textBody;
  }
  return { status: res.status, body: body as Record<string, any> };
}

async function signup(jar: Jar, email: string, displayName: string) {
  const res = await api(jar, "/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: PW, displayName }),
  });
  assert.equal(res.status, 201, `signup ${email}`);
}

/** Uploads a JSON document through the chunked restore endpoints. Returns the upload id. */
async function uploadBackup(jar: Jar, text: string, fileName = "backup.json") {
  const buf = Buffer.from(text, "utf8");
  const start = await api(jar, "/api/account/restore/uploads", {
    method: "POST",
    body: JSON.stringify({ fileName, totalBytes: buf.length }),
  });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const { id, chunkSize, totalChunks } = start.body.upload as {
    id: string;
    chunkSize: number;
    totalChunks: number;
  };
  for (let i = 0; i < totalChunks; i += 1) {
    const slice = buf.subarray(i * chunkSize, Math.min(buf.length, (i + 1) * chunkSize));
    const headers = new Headers({ "Content-Type": "application/octet-stream", Cookie: jar.cookie });
    const res = await fetch(`${BASE}/api/account/restore/uploads/${id}/chunks/${i}`, {
      method: "PUT",
      headers,
      body: new Uint8Array(slice),
    });
    assert.equal(res.status, 200, `chunk ${i}`);
  }
  return { id, totalChunks };
}

const state: Record<string, string> = {};
let backupText = "";
let legacyText = "";
let photoBase64 = "";

before(async () => {
  let res: Response | null = null;
  try {
    res = await fetch(`${BASE}/api/health`);
  } catch {
    res = null;
  }
  if (!res?.ok) throw new Error(`Integration tests need a running server at ${BASE}.`);
});

after(async () => {
  await db.delete(users).where(inArray(users.email, [emailSrc, emailDst, emailLegacy]));
});

describe("source account fixture", () => {
  it("creates rich data: spaces, people, relationships, fields, memories, media, layouts", async () => {
    await signup(src, emailSrc, "Backup Source");

    const spacesList = await api(src, "/api/spaces");
    state.space = (spacesList.body.spaces as Array<{ id: string }>)[0].id;

    // account profile + avatar + About Me field
    await api(src, "/api/account", { method: "PATCH", body: JSON.stringify({ displayName: "Backup Source", bio: "my bio" }) });
    const avatarBytes = Buffer.alloc(2048, 7).toString("base64");
    const avatarRes = await api(src, "/api/account/avatar", {
      method: "PUT",
      body: JSON.stringify({ fileName: "a.png", mimeType: "image/png", data: `data:image/png;base64,${avatarBytes}` }),
    });
    assert.equal(avatarRes.status, 200);
    await api(src, "/api/account/fields", { method: "POST", body: JSON.stringify({ label: "Hometown", value: "Oslo" }) });

    // people
    const alex = await api(src, `/api/spaces/${state.space}`, {
      method: "POST",
      body: JSON.stringify({ name: `Alex ${RUN}`, relationshipToMe: "Sister", tags: ["family"] }),
    });
    assert.equal(alex.status, 201);
    state.alex = alex.body.personId as string;
    const sam = await api(src, `/api/spaces/${state.space}`, {
      method: "POST",
      body: JSON.stringify({ name: `Sam ${RUN}` }),
    });
    state.sam = sam.body.personId as string;

    // directional + mutual relationships between the same pair
    const dir = await api(src, "/api/relationships", {
      method: "POST",
      body: JSON.stringify({ spaceId: state.space, fromPersonId: state.alex, toPersonId: state.sam, label: "Mentor of", type: "directional" }),
    });
    assert.equal(dir.status, 201);
    const mut = await api(src, "/api/relationships", {
      method: "POST",
      body: JSON.stringify({ spaceId: state.space, fromPersonId: state.alex, toPersonId: state.sam, label: "Neighbour", type: "mutual" }),
    });
    assert.equal(mut.status, 201);

    // custom field + memory
    await api(src, `/api/people/${state.alex}/fields`, { method: "POST", body: JSON.stringify({ label: "Phone", value: "+47 123" }) });
    await api(src, `/api/people/${state.alex}/memories`, {
      method: "POST",
      body: JSON.stringify({ title: "Road trip", description: "north", eventDate: "2024-05-01" }),
    });

    // two ~3.4 MB uploads so the backup exceeds the 4.5 MB hosting body limit
    const big = Buffer.alloc(3.4 * 1024 * 1024, 1);
    big.write("\u0089PNG", 0);
    photoBase64 = big.toString("base64");
    for (const name of ["big-one.png", "big-two.png"]) {
      const res = await api(src, `/api/people/${state.alex}/media`, {
        method: "POST",
        body: JSON.stringify({ fileName: name, mimeType: "image/png", data: `data:image/png;base64,${photoBase64}`, caption: "big" }),
      });
      assert.equal(res.status, 201, `upload ${name}`);
    }

    // graph layouts in BOTH view modes
    for (const viewMode of ["circle", "tree"]) {
      const res = await api(src, `/api/spaces/${state.space}`, {
        method: "PUT",
        body: JSON.stringify({
          viewMode,
          positions: [
            { personId: state.alex, x: viewMode === "tree" ? 11 : 101, y: viewMode === "tree" ? 22 : 202 },
            { personId: state.sam, x: 33, y: 44 },
          ],
        }),
      });
      assert.equal(res.status, 200);
    }
  });
});

describe("existing export is unchanged", () => {
  it("still returns circlemap.export.v1 with its original shape", async () => {
    const res = await fetch(`${BASE}/api/account/export`, { headers: { Cookie: src.cookie } });
    assert.equal(res.status, 200);
    legacyText = await res.text();
    const doc = JSON.parse(legacyText);
    assert.equal(doc.format, "circlemap.export.v1");
    assert.deepEqual(Object.keys(doc).sort(), [
      "account",
      "customFields",
      "exportedAt",
      "format",
      "mediaMetadata",
      "memories",
      "people",
      "relationships",
      "spaces",
    ]);
    assert.ok(doc.mediaMetadata.length >= 2);
    assert.equal(doc.mediaMetadata[0].data, undefined, "v1 never carried file contents");
  });

  it("requires authentication", async () => {
    const res = await fetch(`${BASE}/api/account/export`, { redirect: "manual" });
    assert.equal(res.status, 401);
  });
});

describe("full backup download", () => {
  it("streams a valid circlemap.backup.v2 larger than the 4.5 MB body limit", async () => {
    const res = await fetch(`${BASE}/api/account/backup`, { headers: { Cookie: src.cookie } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-backup-format"), "circlemap.backup.v2");
    assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename="circlemap-backup-/);
    assert.equal(res.headers.get("content-length"), null, "response is streamed, not buffered");
    backupText = await res.text();
    assert.ok(backupText.length > 4.5 * 1024 * 1024, `backup is ${backupText.length} bytes`);
  });

  it("requires authentication", async () => {
    const res = await fetch(`${BASE}/api/account/backup`);
    assert.equal(res.status, 401);
  });

  it("contains the actual uploaded file contents and checksums", () => {
    const doc = JSON.parse(backupText);
    assert.equal(doc.format, "circlemap.backup.v2");
    assert.ok(doc.media.length >= 2, "uploaded files are present");
    const big = doc.media.filter((m: { fileName: string }) => m.fileName.startsWith("big-"));
    assert.equal(big.length, 2);
    for (const m of big) {
      assert.equal(m.content.encoding, "base64");
      assert.equal(m.content.data, photoBase64, "exact uploaded bytes are present");
      const buf = Buffer.from(m.content.data, "base64");
      assert.equal(m.content.bytes, buf.length);
      assert.equal(m.content.sha256, createHash("sha256").update(buf).digest("hex"));
    }
    assert.ok(doc.account.avatarData, "account avatar binary is included");
    assert.equal(doc.account.fields.length, 1);
    assert.ok(doc.graphLayouts.some((l: { viewMode: string }) => l.viewMode === "circle"));
    assert.ok(doc.graphLayouts.some((l: { viewMode: string }) => l.viewMode === "tree"));
    assert.equal(doc.integrity.counts.media, doc.media.length);
    assert.equal(doc.integrity.counts.mediaWithPayload, doc.media.length);
    assert.ok(!JSON.stringify(doc).includes("passwordHash"));
    assert.ok(!JSON.stringify(doc).includes("password_hash"));
  });
});

describe("restore into a destination account", () => {
  it("uploads the backup in several chunks and previews it without changing anything", async () => {
    await signup(dst, emailDst, "Backup Dest");
    const before = await api(dst, "/api/spaces");
    state.dstBeforeSpaces = String((before.body.spaces as unknown[]).length);

    const { id, totalChunks } = await uploadBackup(dst, backupText);
    assert.ok(totalChunks > 1, `chunked upload used ${totalChunks} parts`);
    state.upload = id;

    const preview = await api(dst, `/api/account/restore/uploads/${id}`, {
      method: "POST",
      body: JSON.stringify({ action: "validate" }),
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body).slice(0, 300));
    assert.equal(preview.body.preview.format, "circlemap.backup.v2");
    assert.equal(preview.body.preview.destructive, true);
    assert.equal(preview.body.preview.counts.mediaWithPayload >= 2, true);
    assert.equal(preview.body.preview.counts.graphLayouts >= 4, true);

    const after = await api(dst, "/api/spaces");
    assert.equal(String((after.body.spaces as unknown[]).length), state.dstBeforeSpaces, "preview is read-only");
  });

  it("refuses to restore without an explicit acknowledgement", async () => {
    const res = await api(dst, `/api/account/restore/uploads/${state.upload}`, {
      method: "POST",
      body: JSON.stringify({ action: "restore" }),
    });
    assert.equal(res.status, 428);
  });

  it("restores every supported record type", async () => {
    const res = await api(dst, `/api/account/restore/uploads/${state.upload}`, {
      method: "POST",
      body: JSON.stringify({ action: "restore", acknowledge: true }),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
    assert.equal(res.body.result.mode, "replace");

    const after = await fetch(`${BASE}/api/account/backup`, { headers: { Cookie: dst.cookie } });
    const restored = JSON.parse(await after.text());
    const original = JSON.parse(backupText);

    assert.equal(restored.spaces.length, original.spaces.length);
    assert.equal(restored.people.length, original.people.length);
    assert.equal(restored.relationships.length, original.relationships.length);
    assert.equal(restored.customFields.length, original.customFields.length);
    assert.equal(restored.memories.length, original.memories.length);
    assert.equal(restored.media.length, original.media.length);
    assert.equal(restored.graphLayouts.length, original.graphLayouts.length);
    assert.equal(restored.account.fields.length, original.account.fields.length);
    assert.equal(restored.account.bio, original.account.bio);
    assert.equal(restored.account.avatarData, original.account.avatarData);

    // media bytes survive the round trip
    const srcBig = original.media.find((m: { fileName: string }) => m.fileName === "big-one.png");
    const dstBig = restored.media.find((m: { fileName: string }) => m.fileName === "big-one.png");
    assert.equal(dstBig.content.sha256, srcBig.content.sha256);
    assert.equal(dstBig.content.data, srcBig.content.data);

    // directional and mutual relationships both preserved, with labels
    const labels = (doc: { relationships: Array<{ label: string; type: string }> }) =>
      doc.relationships.map((r) => `${r.label}:${r.type}`).sort();
    assert.deepEqual(labels(restored), labels(original));

    // exactly one Me node per space
    const meBySpace = new Map<string, number>();
    for (const p of restored.people as Array<{ spaceId: string; isMe: boolean }>) {
      if (p.isMe) meBySpace.set(p.spaceId, (meBySpace.get(p.spaceId) ?? 0) + 1);
    }
    for (const n of meBySpace.values()) assert.equal(n, 1);

    // ids are new (never trusted from the file) and references remapped
    const originalIds = new Set((original.spaces as Array<{ id: string }>).map((s) => s.id));
    for (const s of restored.spaces as Array<{ id: string }>) assert.equal(originalIds.has(s.id), false);
    const personIds = new Set((restored.people as Array<{ id: string }>).map((p) => p.id));
    for (const r of restored.relationships as Array<{ fromPersonId: string; toPersonId: string }>) {
      assert.ok(personIds.has(r.fromPersonId) && personIds.has(r.toPersonId));
    }
    for (const m of restored.media as Array<{ personId: string }>) assert.ok(personIds.has(m.personId));
    for (const l of restored.graphLayouts as Array<{ personId: string }>) assert.ok(personIds.has(l.personId));

    // layout positions for both view modes survived
    const tree = (restored.graphLayouts as Array<{ viewMode: string; x: number }>).filter((l) => l.viewMode === "tree");
    assert.ok(tree.length >= 2);
  });

  it("keeps the destination account's identity, credentials and session", async () => {
    const me = await api(dst, "/api/account");
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, emailDst, "email is never replaced by the backup");
    const [row] = await db.select().from(users).where(eq(users.email, emailDst));
    assert.ok(row.passwordHash.length > 10);
    const live = await db.select().from(sessions).where(eq(sessions.userId, row.id));
    assert.ok(live.length >= 1, "session rows retained");
    const relogin = await api({ cookie: "" }, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: emailDst, password: PW }),
    });
    assert.equal(relogin.status, 200, "original password still works");
  });

  it("deletes the staged upload after a successful restore", async () => {
    const rows = await db.select().from(backupUploads).where(eq(backupUploads.id, state.upload));
    assert.equal(rows.length, 0);
    const chunks = await db.select().from(backupUploadChunks).where(eq(backupUploadChunks.uploadId, state.upload));
    assert.equal(chunks.length, 0);
  });
});

describe("legacy circlemap.export.v1 import", () => {
  it("is recognized and previewed as a partial export", async () => {
    await signup(legacyJar, emailLegacy, "Legacy Dest");
    const { id } = await uploadBackup(legacyJar, legacyText, "old-export.json");
    state.legacyUpload = id;
    const preview = await api(legacyJar, `/api/account/restore/uploads/${id}`, {
      method: "POST",
      body: JSON.stringify({ action: "validate" }),
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.preview.format, "circlemap.export.v1");
    assert.equal(preview.body.preview.legacy, true);
    assert.equal(preview.body.preview.destructive, false);
    assert.match(preview.body.preview.notRecoverable.join(" "), /Uploaded photos and documents/);
  });

  it("imports non-destructively and reports what the old format never contained", async () => {
    const beforeSpaces = (await api(legacyJar, "/api/spaces")).body.spaces as Array<{ id: string }>;
    const res = await api(legacyJar, `/api/account/restore/uploads/${state.legacyUpload}`, {
      method: "POST",
      body: JSON.stringify({ action: "restore", acknowledge: true }),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
    assert.equal(res.body.result.mode, "merge");
    assert.equal(res.body.result.restored.media, 0, "no broken media rows from metadata");
    assert.match(res.body.result.skipped.join(" "), /metadata only/);

    const afterSpaces = (await api(legacyJar, "/api/spaces")).body.spaces as Array<{ id: string }>;
    assert.equal(afterSpaces.length, beforeSpaces.length + 1, "existing spaces preserved, export added");
    for (const s of beforeSpaces) {
      assert.ok(afterSpaces.some((a) => a.id === s.id), "pre-existing space still there");
    }
    const check = await fetch(`${BASE}/api/account/backup`, { headers: { Cookie: legacyJar.cookie } });
    const doc = JSON.parse(await check.text());
    const imported = (doc.spaces as Array<{ id: string }>).filter((s) => !beforeSpaces.some((b) => b.id === s.id));
    assert.equal(imported.length, 1);
    const importedPeople = (doc.people as Array<{ spaceId: string; isMe: boolean }>).filter((p) => p.spaceId === imported[0].id);
    assert.equal(importedPeople.filter((p) => p.isMe).length, 1, "one Me node in the imported space");
  });
});

describe("rejections and safety", () => {
  it("rejects a corrupted JSON file", async () => {
    const { id } = await uploadBackup(dst, "{ this is not json", "broken.json");
    const res = await api(dst, `/api/account/restore/uploads/${id}`, {
      method: "POST",
      body: JSON.stringify({ action: "validate" }),
    });
    assert.equal(res.status, 422);
    await api(dst, `/api/account/restore/uploads/${id}`, { method: "DELETE" });
  });

  it("rejects an unknown format", async () => {
    const { id } = await uploadBackup(dst, JSON.stringify({ format: "other.v1", spaces: [] }), "other.json");
    const res = await api(dst, `/api/account/restore/uploads/${id}`, {
      method: "POST",
      body: JSON.stringify({ action: "validate" }),
    });
    assert.equal(res.status, 422);
    assert.match(String(res.body.error), /Unrecognised file/);
  });

  it("rejects a backup containing a cross-Space relationship", async () => {
    const doc = JSON.parse(backupText);
    doc.spaces.push({ id: randomUUID(), name: "Other", icon: "🏠", color: "#fff" });
    doc.people.push({ id: randomUUID(), spaceId: doc.spaces[doc.spaces.length - 1].id, name: "Outsider", isMe: false, tags: [] });
    doc.relationships.push({
      id: randomUUID(),
      spaceId: doc.spaces[0].id,
      fromPersonId: doc.people[0].id,
      toPersonId: doc.people[doc.people.length - 1].id,
      label: "Bad",
      type: "mutual",
    });
    const { id } = await uploadBackup(dst, JSON.stringify(doc), "cross.json");
    const res = await api(dst, `/api/account/restore/uploads/${id}`, {
      method: "POST",
      body: JSON.stringify({ action: "validate" }),
    });
    assert.equal(res.status, 422);
    assert.match(String(res.body.error), /crosses Spaces/);
    await api(dst, `/api/account/restore/uploads/${id}`, { method: "DELETE" });
  });

  it("rejects an oversized file before any upload happens", async () => {
    const res = await api(dst, "/api/account/restore/uploads", {
      method: "POST",
      body: JSON.stringify({ fileName: "huge.json", totalBytes: 400 * 1024 * 1024 }),
    });
    assert.equal(res.status, 413);
  });

  it("rejects another user's staged upload", async () => {
    const { id } = await uploadBackup(legacyJar, JSON.stringify({ format: "circlemap.backup.v2" }), "x.json");
    const res = await api(dst, `/api/account/restore/uploads/${id}`, {
      method: "POST",
      body: JSON.stringify({ action: "validate" }),
    });
    assert.equal(res.status, 404);
    await api(legacyJar, `/api/account/restore/uploads/${id}`, { method: "DELETE" });
  });

  it("rolls back a failing restore without losing pre-existing data", async () => {
    const doc = JSON.parse(backupText);
    // A NUL character is valid JSON but cannot be stored in a Postgres text column,
    // so the INSERT fails midway through the restore transaction.
    doc.people[doc.people.length - 1].name = "Bro\u0000ken";
    const { id } = await uploadBackup(dst, JSON.stringify(doc), "fails.json");
    const before = JSON.parse(await (await fetch(`${BASE}/api/account/backup`, { headers: { Cookie: dst.cookie } })).text());
    const res = await api(dst, `/api/account/restore/uploads/${id}`, {
      method: "POST",
      body: JSON.stringify({ action: "restore", acknowledge: true }),
    });
    assert.ok(res.status >= 400, `restore should fail, got ${res.status}`);
    const after = JSON.parse(await (await fetch(`${BASE}/api/account/backup`, { headers: { Cookie: dst.cookie } })).text());
    assert.equal(after.spaces.length, before.spaces.length);
    assert.equal(after.people.length, before.people.length);
    assert.equal(after.media.length, before.media.length);
    assert.deepEqual(
      (after.spaces as Array<{ id: string }>).map((s) => s.id).sort(),
      (before.spaces as Array<{ id: string }>).map((s) => s.id).sort(),
      "pre-existing rows untouched after rollback",
    );
    await api(dst, `/api/account/restore/uploads/${id}`, { method: "DELETE" });
  });

  it("expires and cleans up abandoned upload staging", async () => {
    const { id } = await uploadBackup(dst, JSON.stringify({ format: "circlemap.backup.v2" }), "abandoned.json");
    await db
      .update(backupUploads)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(backupUploads.id, id));
    const res = await api(dst, `/api/account/restore/uploads/${id}`, {
      method: "POST",
      body: JSON.stringify({ action: "validate" }),
    });
    assert.equal(res.status, 410, "expired uploads are refused");
    const rows = await db.select().from(backupUploads).where(eq(backupUploads.id, id));
    assert.equal(rows.length, 0, "expired row removed");

    const stale = await db
      .insert(backupUploads)
      .values({
        userId: (await db.select().from(users).where(eq(users.email, emailDst)))[0].id,
        fileName: "stale.json",
        totalBytes: 10,
        totalChunks: 1,
        chunkSize: 10,
        expiresAt: new Date(Date.now() - 60_000),
      })
      .returning();
    const purge = await api(dst, "/api/account/restore/uploads", { method: "DELETE" });
    assert.equal(purge.status, 200);
    const left = await db.select().from(backupUploads).where(eq(backupUploads.id, stale[0].id));
    assert.equal(left.length, 0, "sweep removed the abandoned upload");
  });

  it("leaves no orphaned rows for the restored account", async () => {
    const [row] = await db.select().from(users).where(eq(users.email, emailDst));
    const owned = await db.select({ n: sql<number>`count(*)::int` }).from(spaces).where(eq(spaces.userId, row.id));
    assert.ok(owned[0].n > 0);
  });
});
