import { jsonError, jsonOk, readJson, route } from "@/lib/api";
import { HttpError, requireUser } from "@/lib/auth";
import {
  BACKUP_FORMAT_V2,
  importLegacyExport,
  LEGACY_FORMAT_V1,
  parseBackupText,
  restoreFullBackup,
  validateBackupDocument,
} from "@/lib/backup";
import { assembleUpload, deleteUpload, markUpload, requireUpload } from "@/lib/backupUploads";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * action=validate → reassemble + validate the staged file and return a truthful preview.
 * action=restore  → perform the restore/import inside a single database transaction.
 *
 * Nothing is ever written to the account by `validate`.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return route(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await readJson(request);
    const action = body.action === "restore" ? "restore" : "validate";

    const upload = await requireUpload(user, id);
    const text = await assembleUpload(user, id);
    const raw = parseBackupText(text);
    const check = validateBackupDocument(raw);
    if (!check.ok) {
      return jsonError(check.errors.join(" "), 422);
    }

    if (action === "validate") {
      await markUpload(upload.id, "validated");
      return jsonOk({ preview: check.preview, uploadId: upload.id });
    }

    if (body.acknowledge !== true) {
      throw new HttpError(428, "You must acknowledge what this restore will do before it can run.");
    }
    // Guard against double submissions of the same staged upload.
    if (upload.status === "consumed") {
      throw new HttpError(409, "That backup was already restored. Choose the file again to repeat it.");
    }
    await markUpload(upload.id, "consumed");

    let result;
    try {
      result =
        check.preview.format === BACKUP_FORMAT_V2
          ? await restoreFullBackup(user, raw)
          : await importLegacyExport(user, raw);
    } catch (err) {
      // The restore itself is transactional: on failure nothing changed, so the
      // staged upload is made available again instead of being discarded.
      await markUpload(upload.id, "validated");
      throw err;
    }

    await deleteUpload(user, upload.id);
    return jsonOk({ result, format: result.format === BACKUP_FORMAT_V2 ? BACKUP_FORMAT_V2 : LEGACY_FORMAT_V1 });
  });
}

/** Abort / discard a staged upload. */
export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  return route(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    await deleteUpload(user, id);
    return jsonOk({ ok: true });
  });
}
