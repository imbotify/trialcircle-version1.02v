import { route } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { streamBackup } from "@/lib/backup";

export const dynamic = "force-dynamic";
// Streaming avoids the 4.5 MB Vercel Function response-body limit.
export const maxDuration = 300;

/**
 * Full backup download (`circlemap.backup.v2`), including uploaded file contents.
 * Separate from the unchanged `/api/account/export` (circlemap.export.v1) route.
 */
export async function GET() {
  return route(async () => {
    const user = await requireUser();
    const stream = streamBackup(user);
    return new Response(stream, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Backup-Format": "circlemap.backup.v2",
        "Content-Disposition": `attachment; filename="circlemap-backup-${new Date().toISOString().slice(0, 10)}.json"`,
      },
    });
  });
}
