/**
 * Integration tests: HTTP API + SQL-level verification (Phase 0.5, item 14).
 *
 * Requires a running server:
 *   TEST_BASE_URL=http://localhost:3000 npx tsx --test tests/integration/*.test.ts
 *
 * Creates uniquely-named QA users and deletes them afterward — re-runnable
 * against a dev database. Never touches other users' data.
 */
import "dotenv/config";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../src/db/index";
import {
  customFields,
  graphLayouts,
  media,
  memories,
  people,
  relationships,
  sessions,
  spaces,
  userFields,
  users,
} from "../../src/db/schema";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const RUN = Date.now().toString(36);
const emailA = `recon-a-${RUN}@example.com`;
const emailB = `recon-b-${RUN}@example.com`;
const emailC = `recon-c-${RUN}@example.com`;
const PW = "password123";

type Jar = { cookie: string };
const jarA: Jar = { cookie: "" };
const jarB: Jar = { cookie: "" };

async function api(jar: Jar | null, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  if (jar?.cookie) headers.set("Cookie", jar.cookie);
  const res = await fetch(BASE + path, { ...init, headers });
  const getSetCookie = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  for (const c of getSetCookie?.call(res.headers) ?? []) {
    const pair = c.split(";")[0].trim();
    if (!jar) continue;
    if (pair === "cm_session=") jar.cookie = "";
    else if (pair.startsWith("cm_session=")) jar.cookie = pair;
  }
  const textBody = await res.text();
  let body: unknown = null;
  try {
    body = textBody ? JSON.parse(textBody) : null;
  } catch {
    body = textBody;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: body as Record<string, any> };
}

async function raw(jar: Jar | null, path: string) {
  const headers = new Headers();
  if (jar?.cookie) headers.set("Cookie", jar.cookie);
  const res = await fetch(BASE + path, { headers });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, bytes: buf, contentType: res.headers.get("content-type") };
}

async function countWhere(tableName: string, column: string, value: string): Promise<number> {
  const rows = await db.execute(sql`select count(*)::int as n from ${sql.identifier(tableName)} where ${sql.identifier(column)} = ${value}`);
  const result = rows as unknown as Array<{ n: number }> | { rows?: Array<{ n: number }> };
  if (Array.isArray(result)) return result[0]?.n ?? 0;
  return result.rows?.[0]?.n ?? 0;
}

const state: Record<string, string> = {};

before(async () => {
  let res: Response | null = null;
  try {
    res = await fetch(`${BASE}/api/health`);
  } catch {
    res = null;
  }
  if (!res?.ok) {
    throw new Error(
      `Integration tests need a running server at ${BASE} (start it, then set TEST_BASE_URL).`,
    );
  }
});

describe("auth", () => {
  it("rejects invalid signup payloads with 422", async () => {
    const badEmail = await api(null, "/api/auth/signup", { method: "POST", body: JSON.stringify({ email: "nope", password: PW, displayName: "QA" }) });
    assert.equal(badEmail.status, 422);
    const shortPw = await api(null, "/api/auth/signup", { method: "POST", body: JSON.stringify({ email: emailA, password: "short", displayName: "QA" }) });
    assert.equal(shortPw.status, 422);
    const shortName = await api(null, "/api/auth/signup", { method: "POST", body: JSON.stringify({ email: emailA, password: PW, displayName: "Q" }) });
    assert.equal(shortName.status, 422);
  });

  it("signs up user A with a seeded starter space", async () => {
    const res = await api(jarA, "/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: emailA, password: PW, displayName: "Recon A" }),
    });
    assert.equal(res.status, 201);
    assert.ok(jarA.cookie.includes("cm_session="), "session cookie set");
    const list = await api(jarA, "/api/spaces");
    assert.equal(list.status, 200);
    const spacesList = list.body.spaces as Array<{ id: string; name: string; peopleCount: number; connectionCount: number }>;
    assert.equal(spacesList.length, 1);
    assert.equal(spacesList[0].name, "My Family");
    assert.equal(spacesList[0].peopleCount, 6);
    assert.equal(spacesList[0].connectionCount, 14);
    state.spaceA = spacesList[0].id;
  });

  it("signs up user B", async () => {
    const res = await api(jarB, "/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: emailB, password: PW, displayName: "Recon B" }),
    });
    assert.equal(res.status, 201);
  });

  it("rejects duplicate email with 409", async () => {
    const res = await api(null, "/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: emailA, password: PW, displayName: "Dup" }),
    });
    assert.equal(res.status, 409);
  });

  it("rejects wrong passwords and accepts correct ones", async () => {
    const jar: Jar = { cookie: "" };
    const wrong = await api(jar, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: emailA, password: "wrong-password" }),
    });
    assert.equal(wrong.status, 401);
    const ok = await api(jar, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: emailA, password: PW }),
    });
    assert.equal(ok.status, 200);
    assert.ok(jar.cookie.includes("cm_session="));
  });

  it("rejects anonymous access with 401", async () => {
    assert.equal((await api(null, "/api/spaces")).status, 401);
    assert.equal((await api(null, `/api/spaces/${state.spaceA}`)).status, 401);
  });

  it("exposes one-click demo entry when allowed", async () => {
    const jar: Jar = { cookie: "" };
    const res = await api(jar, "/api/auth/demo", { method: "POST" });
    assert.equal(res.status, 200);
    assert.equal((res.body.user as { isDemo: boolean }).isDemo, true);
  });
});

describe("spaces", () => {
  it("creates, renames and lists spaces", async () => {
    const created = await api(jarA, "/api/spaces", {
      method: "POST",
      body: JSON.stringify({ name: "Recon Lab", icon: "🧪", color: "#10B981" }),
    });
    assert.equal(created.status, 201);
    state.spaceA2 = (created.body.space as { id: string }).id;
    const renamed = await api(jarA, `/api/spaces/${state.spaceA2}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Recon Lab 2" }),
    });
    assert.equal(renamed.status, 200);
    const list = await api(jarA, "/api/spaces");
    const names = (list.body.spaces as Array<{ name: string }>).map((s) => s.name);
    assert.ok(names.includes("Recon Lab 2"));
  });
});

describe("people + derived relationshipToMe (RULE R1)", () => {
  it("creates a person with a label as a real Me-edge", async () => {
    const res = await api(jarA, `/api/spaces/${state.spaceA}`, {
      method: "POST",
      body: JSON.stringify({ name: "Zephyr Quill", relationshipToMe: "Mentor", tags: ["QA"] }),
    });
    assert.equal(res.status, 201);
    state.zephyr = res.body.personId as string;
    const graph = res.body as { people: Array<{ id: string; relationshipToMe: string | null; isMe: boolean }>; relationships: Array<{ fromPersonId: string; toPersonId: string; label: string }> };
    const me = graph.people.find((p) => p.isMe)!;
    const person = graph.people.find((p) => p.id === state.zephyr)!;
    assert.equal(person.relationshipToMe, "Mentor");
    assert.ok(
      graph.relationships.some(
        (r) =>
          r.label === "Mentor" &&
          ((r.fromPersonId === me.id && r.toPersonId === state.zephyr) ||
            (r.fromPersonId === state.zephyr && r.toPersonId === me.id)),
      ),
      "Me-edge exists in the graph",
    );
  });

  it("profile edits rename the Me-edge (no column drift possible)", async () => {
    const res = await api(jarA, `/api/people/${state.zephyr}`, {
      method: "PATCH",
      body: JSON.stringify({ relationshipToMe: "Former Mentor" }),
    });
    assert.equal(res.status, 200);
    assert.equal((res.body.person as { relationshipToMe: string }).relationshipToMe, "Former Mentor");
    const graph = await api(jarA, `/api/spaces/${state.spaceA}`);
    const labels = (
      (graph.body as { relationships: Array<{ label: string; fromPersonId: string; toPersonId: string }> }).relationships.filter(
        (r) => r.fromPersonId === state.zephyr || r.toPersonId === state.zephyr,
      )
    ).map((r) => r.label);
    assert.ok(labels.includes("Former Mentor"), "edge label follows the profile edit");
    assert.ok(!labels.includes("Mentor"), "stale label is gone");
  });

  it("clearing the label deletes the primary edge only; person survives", async () => {
    const res = await api(jarA, `/api/people/${state.zephyr}`, {
      method: "PATCH",
      body: JSON.stringify({ relationshipToMe: "" }),
    });
    assert.equal(res.status, 200);
    assert.equal((res.body.person as { relationshipToMe: string | null }).relationshipToMe, null);
    assert.equal(((res.body as { connections: unknown[] }).connections ?? []).length, 0);
    assert.equal((res.body.person as { name: string }).name, "Zephyr Quill");
  });

  it("creates people without labels as edge-less nodes", async () => {
    const mk = async (name: string) => {
      const r = await api(jarA, `/api/spaces/${state.spaceA}`, {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      assert.equal(r.status, 201);
      return r.body.personId as string;
    };
    state.p1 = await mk("Paige One");
    state.p2 = await mk("Perrin Two");
    const detail = await api(jarA, `/api/people/${state.p1}`);
    assert.equal((detail.body.person as { relationshipToMe: string | null }).relationshipToMe, null);
  });

  it("refuses to delete the Me node", async () => {
    const graph = await api(jarA, `/api/spaces/${state.spaceA}`);
    const me = ((graph.body as { people: Array<{ id: string; isMe: boolean }> }).people).find((p) => p.isMe)!;
    const res = await api(jarA, `/api/people/${me.id}`, { method: "DELETE" });
    assert.equal(res.status, 422);
  });
});

describe("relationship semantics (items 2-3)", () => {
  it("creates a mutual edge in canonical order", async () => {
    const res = await api(jarA, "/api/relationships", {
      method: "POST",
      body: JSON.stringify({ fromPersonId: state.p1, toPersonId: state.p2, label: "Test Link", type: "mutual" }),
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.created, true);
    const rel = res.body.relationship as { id: string; fromPersonId: string; toPersonId: string };
    state.edgeMutual = rel.id;
    assert.ok(rel.fromPersonId < rel.toPersonId, "mutual stored canonically (smaller id first)");
  });

  it("is idempotent on exact, case-variant and reversed retries", async () => {
    const retry = await api(jarA, "/api/relationships", {
      method: "POST",
      body: JSON.stringify({ fromPersonId: state.p1, toPersonId: state.p2, label: "Test Link", type: "mutual" }),
    });
    assert.equal(retry.status, 200);
    assert.equal((retry.body.relationship as { id: string }).id, state.edgeMutual);
    const caseVariant = await api(jarA, "/api/relationships", {
      method: "POST",
      body: JSON.stringify({ fromPersonId: state.p1, toPersonId: state.p2, label: "TEST LINK", type: "mutual" }),
    });
    assert.equal(caseVariant.status, 200);
    assert.equal((caseVariant.body.relationship as { id: string }).id, state.edgeMutual);
    const reversed = await api(jarA, "/api/relationships", {
      method: "POST",
      body: JSON.stringify({ fromPersonId: state.p2, toPersonId: state.p1, label: "test link", type: "mutual" }),
    });
    assert.equal(reversed.status, 200);
    assert.equal((reversed.body.relationship as { id: string }).id, state.edgeMutual);
  });

  it("allows reversed directional pairs and multiple labels per pair", async () => {
    const reversed = await api(jarA, "/api/relationships", {
      method: "POST",
      body: JSON.stringify({ fromPersonId: state.p2, toPersonId: state.p1, label: "Reverse Link", type: "directional" }),
    });
    assert.equal(reversed.status, 201);
    state.edgeReverse = (reversed.body.relationship as { id: string }).id;
    const second = await api(jarA, "/api/relationships", {
      method: "POST",
      body: JSON.stringify({ fromPersonId: state.p1, toPersonId: state.p2, label: "Second Link", type: "mutual" }),
    });
    assert.equal(second.status, 201);
    state.edgeSecond = (second.body.relationship as { id: string }).id;
  });

  it("returns 409 for same key with a different type", async () => {
    const clash = await api(jarA, "/api/relationships", {
      method: "POST",
      body: JSON.stringify({ fromPersonId: state.p1, toPersonId: state.p2, label: "Clash", type: "mutual" }),
    });
    assert.equal(clash.status, 201);
    const stored = clash.body.relationship as { fromPersonId: string; toPersonId: string };
    const conflict = await api(jarA, "/api/relationships", {
      method: "POST",
      body: JSON.stringify({
        fromPersonId: stored.fromPersonId,
        toPersonId: stored.toPersonId,
        label: "clash",
        type: "directional",
      }),
    });
    assert.equal(conflict.status, 409);
  });

  it("returns 409 when a rename would collide (RULE D3)", async () => {
    const res = await api(jarA, `/api/items/relationship/${state.edgeSecond}`, {
      method: "PATCH",
      body: JSON.stringify({ label: "test link" }),
    });
    assert.equal(res.status, 409);
  });

  it("rejects self-loops and cross-space edges", async () => {
    const self = await api(jarA, "/api/relationships", {
      method: "POST",
      body: JSON.stringify({ fromPersonId: state.p1, toPersonId: state.p1, label: "Me Myself" }),
    });
    assert.equal(self.status, 422);
    const other = await api(jarA, `/api/spaces/${state.spaceA2}`, {
      method: "POST",
      body: JSON.stringify({ name: "Far Away" }),
    });
    const cross = await api(jarA, "/api/relationships", {
      method: "POST",
      body: JSON.stringify({ fromPersonId: state.p1, toPersonId: other.body.personId, label: "Nope" }),
    });
    assert.equal(cross.status, 422);
  });

  it("reorders canonically on type flip and supports swap", async () => {
    const flip = await api(jarA, `/api/items/relationship/${state.edgeSecond}`, {
      method: "PATCH",
      body: JSON.stringify({ type: "directional" }),
    });
    assert.equal(flip.status, 200);
    const flipped = flip.body.relationship as { fromPersonId: string; toPersonId: string; type: string };
    assert.equal(flipped.type, "directional");
    const swapped = await api(jarA, `/api/items/relationship/${state.edgeSecond}`, {
      method: "PATCH",
      body: JSON.stringify({ swap: true }),
    });
    assert.equal(swapped.status, 200);
    const row = swapped.body.relationship as { fromPersonId: string; toPersonId: string };
    assert.equal(row.fromPersonId, flipped.toPersonId);
    assert.equal(row.toPersonId, flipped.fromPersonId);
  });

  it("deletes only the edge, leaving both people intact", async () => {
    const before = await api(jarA, `/api/spaces/${state.spaceA}`);
    const peopleBefore = ((before.body as { people: unknown[] }).people).length;
    const del = await api(jarA, `/api/items/relationship/${state.edgeReverse}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    const afterRes = await api(jarA, `/api/spaces/${state.spaceA}`);
    const graph = afterRes.body as { people: unknown[]; relationships: Array<{ id: string }> };
    assert.equal(graph.people.length, peopleBefore);
    assert.ok(!graph.relationships.some((r) => r.id === state.edgeReverse));
  });
});

describe("fields, memories, attachments", () => {
  it("runs full field CRUD with reorder", async () => {
    const c1 = await api(jarA, `/api/people/${state.p1}/fields`, {
      method: "POST",
      body: JSON.stringify({ label: "Phone", value: "123" }),
    });
    assert.equal(c1.status, 201);
    const c2 = await api(jarA, `/api/people/${state.p1}/fields`, {
      method: "POST",
      body: JSON.stringify({ label: "City", value: "Jaipur" }),
    });
    const fields = (c2.body as { fields: Array<{ id: string; label: string }> }).fields;
    assert.equal(fields.length, 2);
    state.fieldId = fields[0].id;
    const reorder = await api(jarA, `/api/people/${state.p1}/fields`, {
      method: "PATCH",
      body: JSON.stringify({ order: [fields[1].id, fields[0].id] }),
    });
    assert.equal((reorder.body as { fields: Array<{ label: string }> }).fields[0].label, "City");
    const upd = await api(jarA, `/api/items/field/${state.fieldId}`, {
      method: "PATCH",
      body: JSON.stringify({ value: "456" }),
    });
    assert.equal(upd.status, 200);
    const del = await api(jarA, `/api/items/field/${state.fieldId}`, { method: "DELETE" });
    assert.equal(del.status, 200);
  });

  it("runs memory CRUD with validated photo attachments", async () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const up = await api(jarA, `/api/people/${state.p1}/media`, {
      method: "POST",
      body: JSON.stringify({ fileName: "pic.png", mimeType: "image/png", data: png }),
    });
    assert.equal(up.status, 201);
    const photoId = ((up.body as { media: Array<{ id: string }> }).media)[0].id;

    const created = await api(jarA, `/api/people/${state.p1}/memories`, {
      method: "POST",
      body: JSON.stringify({ title: "Attached Day", eventDate: "2025-06-01", icon: "📎", imageMediaId: photoId }),
    });
    assert.equal(created.status, 201);
    const mem = ((created.body as { memories: Array<{ id: string; imageUrl: string }> }).memories).find(
      (m) => m.imageUrl === `/api/media/${photoId}`,
    );
    assert.ok(mem, "memory resolves attachment to the private media URL");
    state.memId = mem!.id;

    const otherPhoto = await api(jarA, `/api/people/${state.p2}/media`, {
      method: "POST",
      body: JSON.stringify({ fileName: "other.png", mimeType: "image/png", data: png }),
    });
    const otherId = ((otherPhoto.body as { media: Array<{ id: string }> }).media)[0].id;
    const foreign = await api(jarA, `/api/people/${state.p1}/memories`, {
      method: "POST",
      body: JSON.stringify({ title: "Nope", eventDate: "2025-01-01", imageMediaId: otherId }),
    });
    assert.equal(foreign.status, 422);

    const doc = await api(jarA, `/api/people/${state.p1}/media`, {
      method: "POST",
      body: JSON.stringify({ fileName: "n.txt", mimeType: "text/plain", data: "data:text/plain;base64,aGk=" }),
    });
    const docId = ((doc.body as { media: Array<{ id: string; kind: string }> }).media).find((m) => m.kind === "document")!.id;
    const nonPhoto = await api(jarA, `/api/people/${state.p1}/memories`, {
      method: "POST",
      body: JSON.stringify({ title: "Nope", eventDate: "2025-01-01", imageMediaId: docId }),
    });
    assert.equal(nonPhoto.status, 422);

    const upd = await api(jarA, `/api/items/memory/${state.memId}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Attached Day (edited)" }),
    });
    assert.equal(upd.status, 200);
    const del = await api(jarA, `/api/items/memory/${state.memId}`, { method: "DELETE" });
    assert.equal(del.status, 200);
  });
});

describe("media privacy + validation", () => {
  it("streams bytes to the owner only", async () => {
    const detail = await api(jarA, `/api/people/${state.p1}`);
    const photo = ((detail.body as { media: Array<{ id: string; kind: string }> }).media).find((m) => m.kind === "photo")!;
    state.mediaId = photo.id;
    const owner = await raw(jarA, `/api/media/${photo.id}`);
    assert.equal(owner.status, 200);
    assert.ok(owner.bytes.length > 0);
    assert.equal((await raw(jarB, `/api/media/${photo.id}`)).status, 404);
    assert.equal((await raw(null, `/api/media/${photo.id}`)).status, 401);
  });

  it("rejects bad MIME types and oversize files", async () => {
    const bad = await api(jarA, `/api/people/${state.p1}/media`, {
      method: "POST",
      body: JSON.stringify({ fileName: "x.exe", mimeType: "application/x-msdownload", data: "AAAA" }),
    });
    assert.equal(bad.status, 422);
    const big = await api(jarA, `/api/people/${state.p1}/media`, {
      method: "POST",
      body: JSON.stringify({ fileName: "big.png", mimeType: "image/png", data: "A".repeat(6 * 1024 * 1024) }),
    });
    assert.equal(big.status, 422);
  });
});

describe("avatars (item 8)", () => {
  it("uploads a person avatar to a private URL", async () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const res = await api(jarA, `/api/people/${state.p1}/avatar`, {
      method: "POST",
      body: JSON.stringify({ fileName: "face.png", mimeType: "image/png", data: png }),
    });
    assert.equal(res.status, 201);
    const url = (res.body.person as { avatarUrl: string }).avatarUrl;
    assert.ok(url.startsWith("/api/media/"), `avatar is a private URL, got ${url}`);
    assert.equal((await raw(jarA, url)).status, 200);
  });

  it("uploads, serves and clears the account avatar", async () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const up = await api(jarA, "/api/account/avatar", {
      method: "PUT",
      body: JSON.stringify({ mimeType: "image/png", data: png }),
    });
    assert.equal(up.status, 200);
    assert.equal((up.body.user as { avatarUrl: string }).avatarUrl, "/api/account/avatar");
    const served = await raw(jarA, "/api/account/avatar");
    assert.equal(served.status, 200);
    assert.equal(served.contentType, "image/png");
    const cleared = await api(jarA, "/api/account/avatar", {
      method: "PUT",
      body: JSON.stringify({ data: "" }),
    });
    assert.equal(cleared.status, 200);
    assert.equal((cleared.body.user as { avatarUrl: string | null }).avatarUrl, null);
  });
});

describe("graph layout persistence", () => {
  it("persists circle and tree positions independently", async () => {
    const putCircle = await api(jarA, `/api/spaces/${state.spaceA}`, {
      method: "PUT",
      body: JSON.stringify({ viewMode: "circle", positions: [{ personId: state.p1, x: 11, y: 22 }] }),
    });
    assert.equal(putCircle.status, 200);
    const putTree = await api(jarA, `/api/spaces/${state.spaceA}`, {
      method: "PUT",
      body: JSON.stringify({ viewMode: "tree", positions: [{ personId: state.p1, x: 33, y: 44 }] }),
    });
    assert.equal(putTree.status, 200);
    const graph = await api(jarA, `/api/spaces/${state.spaceA}`);
    const layouts = (graph.body as { layouts: Array<{ personId: string; viewMode: string; x: number; y: number }> }).layouts;
    const circle = layouts.find((l) => l.personId === state.p1 && l.viewMode === "circle")!;
    const tree = layouts.find((l) => l.personId === state.p1 && l.viewMode === "tree")!;
    assert.deepEqual([circle.x, circle.y], [11, 22]);
    assert.deepEqual([tree.x, tree.y], [33, 44]);
  });
});

describe("account fields (item 10)", () => {
  it("runs CRUD with isolation", async () => {
    const created = await api(jarA, "/api/account/fields", {
      method: "POST",
      body: JSON.stringify({ label: "Hometown", value: "Jaipur" }),
    });
    assert.equal(created.status, 201);
    const id = (created.body.field as { id: string }).id;
    const list = await api(jarA, "/api/account/fields");
    assert.ok(((list.body.fields as Array<{ id: string }>).some((f) => f.id === id)));
    const upd = await api(jarA, `/api/items/userfield/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ value: "Udaipur" }),
    });
    assert.equal(upd.status, 200);
    assert.equal((await api(jarB, `/api/items/userfield/${id}`, { method: "PATCH", body: JSON.stringify({ value: "x" }) })).status, 404);
    const bList = await api(jarB, "/api/account/fields");
    assert.ok(!((bList.body.fields as Array<{ id: string }>).some((f) => f.id === id)));
    assert.equal((await api(jarA, `/api/items/userfield/${id}`, { method: "DELETE" })).status, 200);
  });
});

describe("cross-user isolation", () => {
  it("returns 404 for every foreign resource", async () => {
    assert.equal((await api(jarB, `/api/spaces/${state.spaceA}`)).status, 404);
    assert.equal((await api(jarB, `/api/people/${state.p1}`)).status, 404);
    assert.equal((await api(jarB, `/api/people/${state.p1}`, { method: "DELETE" })).status, 404);
    assert.equal((await api(jarB, `/api/items/relationship/${state.edgeMutual}`, { method: "DELETE" })).status, 404);
  });
});

describe("export + search", () => {
  it("exports structured data with derived labels", async () => {
    const res = await api(jarA, "/api/account/export");
    assert.equal(res.status, 200);
    const data = res.body as {
      spaces: unknown[];
      people: Array<{ relationshipToMe: string | null }>;
      relationships: unknown[];
    };
    assert.ok(data.spaces.length >= 2);
    assert.ok(data.relationships.length > 10);
    assert.ok(data.people.some((p) => p.relationshipToMe === "Mother"), "derived Me label present");
  });

  it("searches names and edge labels without merging identities", async () => {
    const byName = await api(jarA, "/api/connections?q=zephyr");
    assert.equal(byName.status, 200);
    assert.ok(((byName.body.people as Array<{ name: string }>).some((p) => p.name === "Zephyr Quill")));
    const none = await api(jarA, "/api/connections?q=no-such-thing-xyz");
    assert.equal(((none.body.people as unknown[]).length), 0);
  });
});

describe("database backstops (item 12, direct SQL)", () => {
  it("rejects a second Me, bad enums, dup keys, self-loops and cross-space rows", async () => {
    await assert.rejects(
      db.insert(people).values({ spaceId: state.spaceA, isMe: true }),
      "C1: second Me rejected",
    );
    await assert.rejects(
      db.insert(relationships).values({
        spaceId: state.spaceA,
        fromPersonId: state.p1,
        toPersonId: state.p2,
        label: "zz-probe-type",
        type: "weird",
      }),
      "C2: invalid type rejected",
    );
    await assert.rejects(
      db.insert(relationships).values({
        spaceId: state.spaceA,
        fromPersonId: state.p1,
        toPersonId: state.p1,
        label: "zz-probe-loop",
        type: "mutual",
      }),
      "C9: self-loop rejected",
    );
    await assert.rejects(
      db.insert(relationships).values({
        spaceId: state.spaceA,
        fromPersonId: state.p1,
        toPersonId: state.p2,
        label: "TEST LINK",
        type: "mutual",
      }),
      "C8: duplicate key rejected",
    );
    const other = await api(jarA, `/api/spaces/${state.spaceA2}`, {
      method: "POST",
      body: JSON.stringify({ name: "Probe Far" }),
    });
    await assert.rejects(
      db.insert(relationships).values({
        spaceId: state.spaceA,
        fromPersonId: state.p1,
        toPersonId: other.body.personId as string,
        label: "zz-probe-xspace",
        type: "mutual",
      }),
      "C5/C6: cross-space endpoints rejected",
    );
    await assert.rejects(
      db.insert(graphLayouts).values({ spaceId: state.spaceA, personId: state.p1, viewMode: "bogus", x: 0, y: 0 }),
      "C3: invalid view mode rejected",
    );
    await assert.rejects(
      db.insert(media).values({
        personId: state.p1,
        kind: "audio",
        fileName: "x",
        mimeType: "audio/mpeg",
        sizeBytes: 1,
      }),
      "C4: invalid media kind rejected",
    );
  });
});

describe("account deletion cascades", () => {
  it("removes every owned row and orphan", async () => {
    const jar: Jar = { cookie: "" };
    const signup = await api(jar, "/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: emailC, password: PW, displayName: "Recon C" }),
    });
    assert.equal(signup.status, 201);
    const userId = (signup.body.user as { id: string }).id;
    const list = await api(jar, "/api/spaces");
    const spaceId = ((list.body.spaces as Array<{ id: string }>)[0]).id;
    const person = await api(jar, `/api/spaces/${spaceId}`, {
      method: "POST",
      body: JSON.stringify({ name: "Doomed", relationshipToMe: "Friend" }),
    });
    const pid = person.body.personId as string;
    await api(jar, `/api/people/${pid}/fields`, { method: "POST", body: JSON.stringify({ label: "K", value: "V" }) });
    await api(jar, `/api/people/${pid}/memories`, {
      method: "POST",
      body: JSON.stringify({ title: "T", eventDate: "2025-01-01" }),
    });
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    await api(jar, `/api/people/${pid}/media`, {
      method: "POST",
      body: JSON.stringify({ fileName: "d.png", mimeType: "image/png", data: png }),
    });
    await api(jar, "/api/account/fields", {
      method: "POST",
      body: JSON.stringify({ label: "K", value: "V" }),
    });
    await api(jar, `/api/spaces/${spaceId}`, {
      method: "PUT",
      body: JSON.stringify({ viewMode: "circle", positions: [{ personId: pid, x: 1, y: 2 }] }),
    });

    const del = await api(jar, "/api/account", { method: "DELETE" });
    assert.equal(del.status, 200);

    assert.equal(await countWhere("users", "id", userId), 0);
    assert.equal(await countWhere("spaces", "user_id", userId), 0);
    assert.equal(await countWhere("user_fields", "user_id", userId), 0);
    assert.equal(await countWhere("sessions", "user_id", userId), 0);
    const peopleLeft = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(people)
      .innerJoin(spaces, eq(spaces.id, people.spaceId))
      .where(eq(spaces.userId, userId));
    assert.equal(peopleLeft[0].n, 0);

    const login = await api(null, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: emailC, password: PW }),
    });
    assert.equal(login.status, 401);
  });
});

after(async () => {
  await api(jarA, "/api/account", { method: "DELETE" });
  await api(jarB, "/api/account", { method: "DELETE" });

  // Global integrity: zero orphans, zero cross-space edges, at most one Me per space.
  const relNoFrom = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(relationships)
    .leftJoin(people, eq(people.id, relationships.fromPersonId))
    .where(isNull(people.id));
  assert.equal(relNoFrom[0].n, 0, "no dangling from-endpoints");
  const relNoTo = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(relationships)
    .leftJoin(people, eq(people.id, relationships.toPersonId))
    .where(isNull(people.id));
  assert.equal(relNoTo[0].n, 0, "no dangling to-endpoints");
  const fieldsOrphan = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(customFields)
    .leftJoin(people, eq(people.id, customFields.personId))
    .where(isNull(people.id));
  assert.equal(fieldsOrphan[0].n, 0, "no orphan fields");
  const mediaOrphan = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(media)
    .leftJoin(people, eq(people.id, media.personId))
    .where(isNull(people.id));
  assert.equal(mediaOrphan[0].n, 0, "no orphan media");
  const memOrphan = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(memories)
    .leftJoin(people, eq(people.id, memories.personId))
    .where(isNull(people.id));
  assert.equal(memOrphan[0].n, 0, "no orphan memories");
  const layoutOrphan = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(graphLayouts)
    .leftJoin(people, eq(people.id, graphLayouts.personId))
    .where(isNull(people.id));
  assert.equal(layoutOrphan[0].n, 0, "no orphan layouts");
  const xspace = await db.execute(
    sql`select count(*)::int as n from relationships r
        where not exists (select 1 from people p where p.id = r.from_person_id and p.space_id = r.space_id)
           or not exists (select 1 from people p where p.id = r.to_person_id and p.space_id = r.space_id)`,
  );
  const xrows = xspace as unknown as Array<{ n: number }>;
  assert.equal(Array.isArray(xrows) ? xrows[0]?.n : 0, 0, "no cross-space edges");
});
