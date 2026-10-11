// Server-Sent Events helpers. The agent yields events; this turns them into a streaming Response.

import { friendlyErrorMessage } from "./agent.ts";

export type SseEvent = { type: string; [key: string]: unknown };

export function sseResponse(events: AsyncIterable<SseEvent>, extraHeaders: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  const iterator = events[Symbol.asyncIterator]();
  // Set when the reader goes away (tab closed, "Skip ahead", "Stop"). Stopping the iterator ends the
  // agent loop or replay behind it instead of letting it run on for nobody.
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: SseEvent) => {
        if (!cancelled) controller.enqueue(encoder.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
      };
      try {
        send({ type: "open" });
        while (!cancelled) {
          const next = await iterator.next();
          if (next.done) break;
          send(next.value);
        }
      } catch (err) {
        // The full error goes to the server log; the browser gets a plain sentence (an Anthropic
        // API error names its HTTP status, anything else is "Something went wrong on the server.").
        console.error("[sse] stream failed:", err);
        send({ type: "error", message: friendlyErrorMessage(err) });
      } finally {
        if (!cancelled) controller.close();
      }
    },
    cancel() {
      cancelled = true;
      void iterator.return?.();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      ...extraHeaders,
    },
  });
}

export function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}
