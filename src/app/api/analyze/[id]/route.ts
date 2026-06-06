import { ensureAnalysis, subscribeToAnalysis } from "@/lib/analysis-jobs";
import { getAnalysisForScan, getScan } from "@/lib/db/repository";
import { isValidScanId } from "@/lib/scan-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();
function sse(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * POST /api/analyze/[id]
 *
 * OPTIONAL live view of the analysis. The analysis itself is a server-side
 * background job (auto-started when the scan completes) — this route only
 * ATTACHES to it and tails tokens/progress as SSE:
 *   event: token | progress | result | error | done
 * If the analysis is already done it returns the persisted report. Disconnecting
 * this stream does NOT stop the job (it keeps running and persisting). Next.js 16:
 * `params` is a Promise.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  if (!isValidScanId(id)) {
    return Response.json({ error: "Invalid scan id." }, { status: 400 });
  }
  const scan = getScan(id);
  if (!scan) {
    return Response.json({ error: "Scan not found." }, { status: 404 });
  }
  if (scan.status !== "done") {
    return Response.json(
      { error: `Scan is not ready for analysis (status: ${scan.status}).` },
      { status: 409 },
    );
  }

  // Ensure the background job is running (normally already auto-started).
  ensureAnalysis(id);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe: (() => void) | null = null;

      const send = (chunk: Uint8Array) => {
        if (!closed) {
          try {
            controller.enqueue(chunk);
          } catch {
            /* stream already closed by the runtime */
          }
        }
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        if (unsubscribe) unsubscribe();
        request.signal.removeEventListener("abort", onAbort);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      function onAbort() {
        // Client disconnected — detach only; the job keeps running server-side.
        finish();
      }

      // Already finished? Return the persisted result/error immediately.
      const fresh = getScan(id);
      if (fresh?.analysisStatus === "done") {
        const analysis = getAnalysisForScan(id);
        send(
          analysis
            ? sse("result", { analysis })
            : sse("error", { error: "Analysis marked done but no report found." }),
        );
        send(sse("done", {}));
        finish();
        return;
      }
      if (fresh?.analysisStatus === "error") {
        send(sse("error", { error: fresh.analysisError ?? "Analysis failed." }));
        send(sse("done", {}));
        finish();
        return;
      }

      // Attach to the running job's live events.
      unsubscribe = subscribeToAnalysis(id, (event) => {
        if (event.type === "token") send(sse("token", { value: event.value }));
        else if (event.type === "progress")
          send(sse("progress", { completed: event.completed, total: event.total }));
        else if (event.type === "done") {
          send(sse("result", { analysis: event.analysis }));
          send(sse("done", {}));
          finish();
        } else {
          send(sse("error", { error: event.error }));
          send(sse("done", {}));
          finish();
        }
      });

      if (!unsubscribe) {
        // Raced to completion between the status check and subscribe.
        const analysis = getAnalysisForScan(id);
        const latest = getScan(id);
        send(
          analysis
            ? sse("result", { analysis })
            : sse("error", { error: latest?.analysisError ?? "Analysis is not running." }),
        );
        send(sse("done", {}));
        finish();
        return;
      }

      request.signal.addEventListener("abort", onAbort, { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
