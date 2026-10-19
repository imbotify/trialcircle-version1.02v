import { jsonOk, route } from "@/lib/api";
import { HttpError, requireUser } from "@/lib/auth";
import { saveChunk } from "@/lib/backupUploads";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Receives ONE raw binary chunk (no Base64, no JSON wrapper) so each request stays
 * well below the 4.5 MB Vercel Function request-body limit.
 */
export async function PUT(
  request: Request,
  ctx: { params: Promise<{ id: string; index: string }> },
) {
  return route(async () => {
    const user = await requireUser();
    const { id, index } = await ctx.params;
    const parsed = Number.parseInt(index, 10);
    if (!Number.isInteger(parsed)) throw new HttpError(422, "Invalid chunk index.");
    const bytes = Buffer.from(await request.arrayBuffer());
    const progress = await saveChunk(user, id, parsed, bytes);
    return jsonOk({ ok: true, ...progress });
  });
}
