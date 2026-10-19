/**
 * Minimal, user-scoped staging for chunked backup uploads.
 *
 * Only exists because a Vercel Function request body is capped at 4.5 MB: a backup
 * file is uploaded as raw binary chunks, reassembled here, validated, and only then
 * restored. Rows expire (UPLOAD_TTL_MS) and abandoned uploads are swept lazily on
 * every new upload, so no background infrastructure is required.
 */
import { and, asc, eq, lt } from "drizzle-orm";
import { db } from "@/db";
import { backupUploadChunks, backupUploads, type User } from "@/db/schema";
import { HttpError } from "@/lib/auth";
import { DEFAULT_CHUNK_BYTES, MAX_BACKUP_BYTES, MAX_CHUNK_BYTES, UPLOAD_TTL_MS } from "@/lib/backup";

export type BackupUpload = typeof backupUploads.$inferSelect;

/** Deletes expired staging rows (chunks cascade). Returns the number removed. */
export async function purgeExpiredUploads(): Promise<number> {
  const removed = await db
    .delete(backupUploads)
    .where(lt(backupUploads.expiresAt, new Date()))
    .returning({ id: backupUploads.id });
  return removed.length;
}

export async function createUpload(
  user: User,
  input: { fileName: string; totalBytes: number; chunkSize?: number },
): Promise<BackupUpload> {
  await purgeExpiredUploads();
  const fileName = String(input.fileName ?? "backup.json").slice(0, 200);
  const totalBytes = Number(input.totalBytes);
  if (!Number.isInteger(totalBytes) || totalBytes <= 0) {
    throw new HttpError(422, "That file looks empty.");
  }
  if (totalBytes > MAX_BACKUP_BYTES) {
    throw new HttpError(
      413,
      `That file is ${(totalBytes / 1024 / 1024).toFixed(1)} MB. The maximum restore size is ${MAX_BACKUP_BYTES / 1024 / 1024} MB.`,
    );
  }
  const requested = Number(input.chunkSize ?? DEFAULT_CHUNK_BYTES);
  const chunkSize = Number.isInteger(requested) && requested > 0 && requested <= MAX_CHUNK_BYTES
    ? requested
    : DEFAULT_CHUNK_BYTES;
  const totalChunks = Math.ceil(totalBytes / chunkSize);
  const [row] = await db
    .insert(backupUploads)
    .values({
      userId: user.id,
      fileName,
      totalBytes,
      totalChunks,
      chunkSize,
      expiresAt: new Date(Date.now() + UPLOAD_TTL_MS),
    })
    .returning();
  return row;
}

export async function requireUpload(user: User, id: string): Promise<BackupUpload> {
  const [row] = await db
    .select()
    .from(backupUploads)
    .where(and(eq(backupUploads.id, id), eq(backupUploads.userId, user.id)))
    .limit(1);
  if (!row) throw new HttpError(404, "That upload no longer exists.");
  if (row.expiresAt.getTime() < Date.now()) {
    await db.delete(backupUploads).where(eq(backupUploads.id, row.id));
    throw new HttpError(410, "That upload expired. Please choose the file again.");
  }
  return row;
}

export async function saveChunk(
  user: User,
  uploadId: string,
  index: number,
  bytes: Buffer,
): Promise<{ receivedChunks: number; totalChunks: number }> {
  const upload = await requireUpload(user, uploadId);
  if (!Number.isInteger(index) || index < 0 || index >= upload.totalChunks) {
    throw new HttpError(422, "Invalid chunk index.");
  }
  if (bytes.length === 0) throw new HttpError(422, "Empty chunk.");
  if (bytes.length > MAX_CHUNK_BYTES) {
    throw new HttpError(413, "Chunk too large for the hosting request-body limit.");
  }
  const expected =
    index === upload.totalChunks - 1
      ? upload.totalBytes - upload.chunkSize * index
      : upload.chunkSize;
  if (bytes.length !== expected) {
    throw new HttpError(422, "Chunk size does not match the declared upload.");
  }
  await db
    .insert(backupUploadChunks)
    .values({ uploadId: upload.id, chunkIndex: index, sizeBytes: bytes.length, data: bytes })
    .onConflictDoUpdate({
      target: [backupUploadChunks.uploadId, backupUploadChunks.chunkIndex],
      set: { sizeBytes: bytes.length, data: bytes },
    });
  const rows = await db
    .select({ id: backupUploadChunks.id, size: backupUploadChunks.sizeBytes })
    .from(backupUploadChunks)
    .where(eq(backupUploadChunks.uploadId, upload.id));
  const receivedBytes = rows.reduce((sum, r) => sum + r.size, 0);
  await db.update(backupUploads).set({ receivedBytes }).where(eq(backupUploads.id, upload.id));
  return { receivedChunks: rows.length, totalChunks: upload.totalChunks };
}

/** Verifies every chunk arrived, then reassembles the original UTF-8 document. */
export async function assembleUpload(user: User, uploadId: string): Promise<string> {
  const upload = await requireUpload(user, uploadId);
  const rows = await db
    .select()
    .from(backupUploadChunks)
    .where(eq(backupUploadChunks.uploadId, upload.id))
    .orderBy(asc(backupUploadChunks.chunkIndex));
  if (rows.length !== upload.totalChunks) {
    throw new HttpError(422, `Upload incomplete: ${rows.length} of ${upload.totalChunks} parts received.`);
  }
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].chunkIndex !== i) throw new HttpError(422, `Upload is missing part ${i + 1}.`);
  }
  const buffer = Buffer.concat(rows.map((r) => Buffer.from(r.data)));
  if (buffer.length !== upload.totalBytes) {
    throw new HttpError(422, "The uploaded file is incomplete or corrupted.");
  }
  return buffer.toString("utf8");
}

export async function markUpload(uploadId: string, status: "pending" | "validated" | "consumed") {
  await db.update(backupUploads).set({ status }).where(eq(backupUploads.id, uploadId));
}

export async function deleteUpload(user: User, uploadId: string): Promise<void> {
  await db
    .delete(backupUploads)
    .where(and(eq(backupUploads.id, uploadId), eq(backupUploads.userId, user.id)));
}
