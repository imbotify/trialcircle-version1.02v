import { jsonError, jsonOk, readJson, route } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import {
  deleteField,
  deleteMedia,
  deleteMemory,
  deleteRelationship,
  deleteUserField,
  updateField,
  updateMemory,
  updateRelationship,
  updateUserField,
} from "@/lib/domain";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ type: string; id: string }> };

/** PATCH /api/items/field|memory|relationship|userfield/:id */
export async function PATCH(request: Request, ctx: Ctx) {
  return route(async () => {
    const user = await requireUser();
    const { type, id } = await ctx.params;
    const body = await readJson(request);

    if (type === "field") return jsonOk({ field: await updateField(user, id, body) });
    if (type === "memory") return jsonOk({ memory: await updateMemory(user, id, body) });
    if (type === "relationship") return jsonOk({ relationship: await updateRelationship(user, id, body) });
    if (type === "userfield") return jsonOk({ field: await updateUserField(user, id, body) });
    return jsonError("Unknown item type.", 404);
  });
}

/** DELETE /api/items/field|memory|media|relationship|userfield/:id */
export async function DELETE(_request: Request, ctx: Ctx) {
  return route(async () => {
    const user = await requireUser();
    const { type, id } = await ctx.params;

    if (type === "field") await deleteField(user, id);
    else if (type === "memory") await deleteMemory(user, id);
    else if (type === "media") await deleteMedia(user, id);
    else if (type === "relationship") await deleteRelationship(user, id);
    else if (type === "userfield") await deleteUserField(user, id);
    else return jsonError("Unknown item type.", 404);

    return jsonOk({ ok: true });
  });
}
