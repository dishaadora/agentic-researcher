import { getJob } from "@/lib/agent/jobs";

export const dynamic = "force-dynamic";

/** Streams a job's events. Replays from Last-Event-ID, so a dropped connection loses nothing. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = getJob(id);
  if (!job) return new Response("This run has expired or doesn't exist.", { status: 404 });

  let cursor = Number(request.headers.get("last-event-id") ?? -1) + 1;
  if (!Number.isInteger(cursor) || cursor < 0) cursor = 0;
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const flush = () => {
        for (; cursor < job.events.length; cursor++) {
          controller.enqueue(encoder.encode(`id: ${cursor}\ndata: ${JSON.stringify(job.events[cursor])}\n\n`));
        }
        if (job.finished && cursor >= job.events.length) {
          cleanup();
          controller.close();
        }
      };
      const heartbeat = setInterval(() => controller.enqueue(encoder.encode(": keep-alive\n\n")), 20_000);
      cleanup = () => {
        clearInterval(heartbeat);
        job.listeners.delete(flush);
      };
      job.listeners.add(flush);
      request.signal.addEventListener("abort", () => cleanup());
      flush();
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" },
  });
}
