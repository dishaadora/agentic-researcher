import { NextResponse } from "next/server";
import { z } from "zod";
import { canControl, getJob } from "@/lib/agent/jobs";

const Body = z.object({ action: z.enum(["pause", "resume", "abort"]), token: z.string() });

/** Pauses, resumes or aborts a run. Needs the token handed to whoever started it. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = getJob(id);
  if (!job) return NextResponse.json({ error: "This run has expired or doesn't exist." }, { status: 404 });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  if (!canControl(job, parsed.data.token)) {
    return NextResponse.json({ error: "Only the person who started this run can pause or abort it." }, { status: 403 });
  }

  const problem = job.control(parsed.data.action);
  if (problem) return NextResponse.json({ error: problem }, { status: 409 });
  return NextResponse.json({ paused: job.paused });
}
