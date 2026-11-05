import { guideToMarkdown } from "@/lib/markdown";
import { getGuide } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const guide = getGuide(slug);
  if (!guide) return new Response("Guide not found.", { status: 404 });
  return new Response(guideToMarkdown(guide, new URL(request.url).origin), {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
