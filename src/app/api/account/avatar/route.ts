import { jsonOk, readJson, route } from "@/lib/api";
import { publicUser, requireUser } from "@/lib/auth";
import { uploadAccountAvatar } from "@/lib/domain";

export const dynamic = "force-dynamic";

/**
 * Account avatar (Phase 0.5, item 8). Session-scoped with no id parameter, so
 * there is no IDOR surface: you can only ever read or write your own photo.
 */
export async function GET() {
  return route(async () => {
    const user = await requireUser();
    if (!user.avatarData || !user.avatarMime) {
      return Response.json({ error: "No uploaded photo." }, { status: 404 });
    }
    const buffer = Buffer.from(user.avatarData, "base64");
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": user.avatarMime,
        "Content-Length": String(buffer.length),
        "Cache-Control": "private, max-age=3600",
      },
    });
  });
}

/** Body: { mimeType, data } as a base64 data-URL. Empty `data` clears the photo. */
export async function PUT(request: Request) {
  return route(async () => {
    const user = await requireUser();
    const body = await readJson(request);
    const updated = await uploadAccountAvatar(user, body);
    return jsonOk({ user: publicUser(updated) });
  });
}
