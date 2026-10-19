import { jsonOk, readJson, route } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { DEFAULT_CHUNK_BYTES, MAX_BACKUP_BYTES, MAX_CHUNK_BYTES } from "@/lib/backup";
import { createUpload, purgeExpiredUploads } from "@/lib/backupUploads";

export const dynamic = "force-dynamic";

/** Starts a chunked, authenticated backup upload and sweeps abandoned staging rows. */
export async function POST(request: Request) {
  return route(async () => {
    const user = await requireUser();
    const body = await readJson(request);
    const upload = await createUpload(user, {
      fileName: String(body.fileName ?? "backup.json"),
      totalBytes: Number(body.totalBytes),
      chunkSize: body.chunkSize === undefined ? undefined : Number(body.chunkSize),
    });
    return jsonOk({
      upload: {
        id: upload.id,
        chunkSize: upload.chunkSize,
        totalChunks: upload.totalChunks,
        expiresAt: upload.expiresAt.toISOString(),
      },
      limits: { maxBackupBytes: MAX_BACKUP_BYTES, maxChunkBytes: MAX_CHUNK_BYTES, defaultChunkBytes: DEFAULT_CHUNK_BYTES },
    });
  });
}

/** Cleanup entrypoint for abandoned uploads (also runs automatically on POST). */
export async function DELETE() {
  return route(async () => {
    await requireUser();
    const removed = await purgeExpiredUploads();
    return jsonOk({ removed });
  });
}
