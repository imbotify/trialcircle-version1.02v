import { jsonOk, readJson, route } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { createUserField, listUserFields, reorderUserFields } from "@/lib/domain";

export const dynamic = "force-dynamic";

/** Account "About Me" custom fields (Phase 0.5, item 10). */
export async function GET() {
  return route(async () => {
    const user = await requireUser();
    return jsonOk({ fields: await listUserFields(user) });
  });
}

export async function POST(request: Request) {
  return route(async () => {
    const user = await requireUser();
    const body = await readJson(request);
    const field = await createUserField(user, body);
    return jsonOk({ field }, { status: 201 });
  });
}

/** Reorder: PATCH { order: [fieldId, ...] } */
export async function PATCH(request: Request) {
  return route(async () => {
    const user = await requireUser();
    const body = await readJson(request);
    await reorderUserFields(user, body.order);
    return jsonOk({ fields: await listUserFields(user) });
  });
}
