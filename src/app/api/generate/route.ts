import { NextResponse } from "next/server";
import { z } from "zod";
import { checkLimits, isConfigured, startJob } from "@/lib/agent/jobs";
import { findGuide } from "@/lib/store";

const Body = z.object(
  {
    query: z
      .string({ error: "Enter an app name or website." })
      .trim()
      .min(2, "Enter an app name or website.")
      .max(200, "That's too long. Enter just the app name or website.")
      .regex(/^[^<>\p{Cc}]+$/u, "Enter just the app name or website."),
  },
  { error: "Enter an app name or website." },
);

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Enter an app name or website." }, { status: 400 });
  }
  const { query } = parsed.data;

  // An existing guide costs nothing, so this comes before configuration and limit checks.
  const existing = findGuide(query);
  if (existing) return NextResponse.json({ slug: existing.slug });

  if (!isConfigured()) {
    return NextResponse.json({ error: "Live generation isn't set up here because no API key is configured. You can still browse the library." }, { status: 503 });
  }
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const limited = checkLimits(ip);
  if (limited) return NextResponse.json({ error: limited }, { status: 429 });

  const { job, created } = startJob(query, ip);
  // Someone joining a run that was already going can watch it, but only whoever started it can stop it.
  return NextResponse.json({ jobId: job.id, controlToken: created ? job.controlToken : undefined });
}
