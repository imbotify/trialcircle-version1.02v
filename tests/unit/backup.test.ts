/**
 * Unit tests for the backup format: validation, preview counts and legacy detection.
 * Pure functions only — no database access.
 *
 *   npx tsx --test tests/unit/backup.test.ts
 */
import "dotenv/config";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  BACKUP_FORMAT_V2,
  LEGACY_FORMAT_V1,
  detectFormat,
  parseBackupText,
  validateBackupDocument,
  validateBackupV2,
  validateLegacyV1,
} from "../../src/lib/backup";

const SPACE = "11111111-1111-1111-1111-111111111111";
const ME = "22222222-2222-2222-2222-222222222222";
const ALEX = "33333333-3333-3333-3333-333333333333";
const MEDIA = "44444444-4444-4444-4444-444444444444";

const payload = Buffer.from("hello circlemap backup");
const b64 = payload.toString("base64");
const sha = createHash("sha256").update(payload).digest("hex");

type Doc = Record<string, unknown>;

function validDoc(): Doc {
  return {
    format: BACKUP_FORMAT_V2,
    formatVersion: 2,
    exportedAt: "2026-01-01T00:00:00.000Z",
    sourceAccount: { email: "owner@example.com" },
    account: { displayName: "Owner", bio: "hi", avatarData: null, fields: [{ id: "f1", label: "City", value: "Oslo" }] },
    spaces: [{ id: SPACE, name: "Family", icon: "🏠", color: "#6366F1" }],
    people: [
      { id: ME, spaceId: SPACE, name: "Owner", isMe: true, tags: [] },
      { id: ALEX, spaceId: SPACE, name: "Alex", isMe: false, tags: ["friend"] },
    ],
    relationships: [
      { id: "r1", spaceId: SPACE, fromPersonId: ME, toPersonId: ALEX, label: "Sister", type: "mutual" },
      { id: "r2", spaceId: SPACE, fromPersonId: ALEX, toPersonId: ME, label: "Mentor of", type: "directional" },
    ],
    customFields: [{ id: "c1", personId: ALEX, label: "Phone", value: "123", sortOrder: 0 }],
    memories: [{ id: "m1", personId: ALEX, title: "Trip", eventDate: "2024-05-01", imageMediaId: MEDIA }],
    media: [
      {
        id: MEDIA,
        personId: ALEX,
        kind: "photo",
        fileName: "pic.png",
        mimeType: "image/png",
        sizeBytes: payload.length,
        content: { encoding: "base64", bytes: payload.length, sha256: sha, data: b64 },
        externalReference: null,
      },
    ],
    graphLayouts: [{ id: "g1", spaceId: SPACE, personId: ALEX, viewMode: "tree", x: 10, y: 20, pinned: true }],
    integrity: { counts: { people: 2 }, totalMediaBytes: payload.length },
  };
}

describe("backup format detection", () => {
  it("detects both supported formats and rejects anything else", () => {
    assert.equal(detectFormat({ format: BACKUP_FORMAT_V2 }), BACKUP_FORMAT_V2);
    assert.equal(detectFormat({ format: LEGACY_FORMAT_V1 }), LEGACY_FORMAT_V1);
    assert.equal(detectFormat({ format: "something.else" }), null);
    assert.equal(detectFormat("nope"), null);
  });

  it("rejects corrupted JSON", () => {
    assert.throws(() => parseBackupText("{ not json"), /valid JSON/);
  });

  it("rejects an unknown document", () => {
    const res = validateBackupDocument({ format: "foo.v9" });
    assert.equal(res.ok, false);
  });
});

describe("circlemap.backup.v2 validation", () => {
  it("accepts a complete backup and counts real records", () => {
    const res = validateBackupV2(validDoc());
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.preview.legacy, false);
    assert.equal(res.preview.destructive, true);
    assert.deepEqual(
      {
        spaces: res.preview.counts.spaces,
        people: res.preview.counts.people,
        meNodes: res.preview.counts.meNodes,
        mutual: res.preview.counts.mutualRelationships,
        directional: res.preview.counts.directionalRelationships,
        media: res.preview.counts.mediaWithPayload,
        layouts: res.preview.counts.graphLayouts,
        fields: res.preview.counts.customFields,
        accountFields: res.preview.counts.accountFields,
        memories: res.preview.counts.memories,
      },
      {
        spaces: 1,
        people: 2,
        meNodes: 1,
        mutual: 1,
        directional: 1,
        media: 1,
        layouts: 1,
        fields: 1,
        accountFields: 1,
        memories: 1,
      },
    );
    assert.equal(res.preview.mediaBytes, payload.length);
  });

  it("rejects media without actual file contents", () => {
    const doc = validDoc();
    (doc.media as Doc[])[0].content = null;
    (doc.media as Doc[])[0].externalReference = null;
    const res = validateBackupV2(doc);
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.errors.join(" "), /neither file contents nor an external reference/);
  });

  it("rejects media whose checksum does not match", () => {
    const doc = validDoc();
    (doc.media as Doc[])[0].content = {
      encoding: "base64",
      bytes: payload.length,
      sha256: "0".repeat(64),
      data: b64,
    };
    const res = validateBackupV2(doc);
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.errors.join(" "), /checksum/);
  });

  it("keeps external references honest instead of claiming a payload", () => {
    const doc = validDoc();
    (doc.media as Doc[])[0].content = null;
    (doc.media as Doc[])[0].externalReference = { url: "https://example.com/a.jpg", binaryIncluded: false };
    const res = validateBackupV2(doc);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.preview.counts.externalMediaReferences, 1);
    assert.equal(res.preview.counts.mediaWithPayload, 0);
    assert.match(res.preview.notRecoverable.join(" "), /never stored/);
  });

  it("rejects a relationship that crosses Spaces", () => {
    const doc = validDoc();
    (doc.spaces as Doc[]).push({ id: "55555555-5555-5555-5555-555555555555", name: "Work" });
    (doc.people as Doc[]).push({
      id: "66666666-6666-6666-6666-666666666666",
      spaceId: "55555555-5555-5555-5555-555555555555",
      name: "Sam",
    });
    (doc.relationships as Doc[]).push({
      id: "r3",
      spaceId: SPACE,
      fromPersonId: ALEX,
      toPersonId: "66666666-6666-6666-6666-666666666666",
      label: "Colleague",
      type: "mutual",
    });
    const res = validateBackupV2(doc);
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.errors.join(" "), /crosses Spaces/);
  });

  it("rejects a foreign (cross-user) person reference", () => {
    const doc = validDoc();
    (doc.people as Doc[])[1].spaceId = "99999999-9999-9999-9999-999999999999";
    const res = validateBackupV2(doc);
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.errors.join(" "), /Space that is not in this backup/);
  });

  it("rejects two Me nodes in one Space", () => {
    const doc = validDoc();
    (doc.people as Doc[])[1].isMe = true;
    const res = validateBackupV2(doc);
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.errors.join(" "), /more than one "Me" node/);
  });

  it("rejects a graph layout pointing outside its Space", () => {
    const doc = validDoc();
    (doc.graphLayouts as Doc[])[0].spaceId = "99999999-9999-9999-9999-999999999999";
    const res = validateBackupV2(doc);
    assert.equal(res.ok, false);
  });

  it("rejects a backup that is missing whole sections", () => {
    const doc = validDoc();
    delete doc.graphLayouts;
    const res = validateBackupV2(doc);
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.errors.join(" "), /graphLayouts/);
  });
});

describe("circlemap.export.v1 (legacy) handling", () => {
  const legacy = {
    exportedAt: "2025-01-01T00:00:00.000Z",
    format: LEGACY_FORMAT_V1,
    account: { email: "owner@example.com", displayName: "Owner", bio: null },
    spaces: [{ id: SPACE, name: "Family", description: null, icon: "🏠", color: "#6366F1" }],
    people: [
      { id: ME, spaceId: SPACE, name: "Owner", isMe: true, relationshipToMe: "This is you", tags: [] },
      { id: ALEX, spaceId: SPACE, name: "Alex", isMe: false, relationshipToMe: "Sister", tags: [] },
    ],
    relationships: [{ id: "r1", spaceId: SPACE, from: ME, to: ALEX, label: "Sister", type: "mutual" }],
    customFields: [{ personId: ALEX, label: "Phone", value: "123" }],
    memories: [{ personId: ALEX, title: "Trip", description: null, eventDate: "2024-05-01" }],
    mediaMetadata: [{ id: MEDIA, personId: ALEX, kind: "photo", fileName: "pic.png", mimeType: "image/png", sizeBytes: 22, caption: null }],
  };

  it("is recognized as a legacy partial export", () => {
    const res = validateLegacyV1(legacy);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.preview.legacy, true);
    assert.equal(res.preview.destructive, false);
    assert.equal(res.preview.counts.media, 0);
    assert.equal(res.preview.counts.graphLayouts, 0);
  });

  it("states exactly what the old format never contained", () => {
    const res = validateLegacyV1(legacy);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const text = res.preview.notRecoverable.join(" ");
    assert.match(text, /Uploaded photos and documents/);
    assert.match(text, /avatar/i);
    assert.match(text, /graph layout/i);
  });

  it("rejects an empty legacy export", () => {
    const res = validateLegacyV1({ format: LEGACY_FORMAT_V1, spaces: [], people: [], relationships: [] });
    assert.equal(res.ok, false);
  });
});
