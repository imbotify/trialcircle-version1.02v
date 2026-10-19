import { jsonOk, readJson, route } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getPersonDetail, uploadPersonAvatar } from "@/lib/domain";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Person avatar upload (Phase 0.5, item 8). Creates a gallery photo and points
 * the person's avatar at its private URL. Body: { fileName, mimeType, data }.
 */
export async function POST(request: Request, ctx: Ctx) {
  return route(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await readJson(request);
    await uploadPersonAvatar(user, id, body);
    return jsonOk(await getPersonDetail(user, id), { status: 201 });
  });
}
