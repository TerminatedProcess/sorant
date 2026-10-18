import { unauthorized } from "@/lib/auth";
import { compatReport } from "@/lib/compat";
import { errorResponse } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * Whether the ComfyUI machine has what each workflow needs. Asked once the
 * page has loaded rather than inside /api/workflows, so a slow ComfyUI never
 * holds up the page. See src/lib/compat.ts.
 */
export async function GET(request: Request) {
  const denied = unauthorized(request);
  if (denied) return denied;

  try {
    return Response.json(await compatReport());
  } catch (error) {
    return errorResponse(error);
  }
}
