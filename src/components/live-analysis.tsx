"use client";

/**
 * Live view of the LLM "thinking" — streams raw tokens so the user watches the
 * engineer work instead of staring at a frozen spinner. Auto-scrolls to follow
 * output unless the user scrolls up.
 */
import { useEffect, useRef } from "react";
import { ActivityIcon } from "@/components/icons";
import { Card, CardHeader } from "@/components/ui/primitives";

export function LiveAnalysis({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <Card>
      <CardHeader
        title="Live analysis"
        icon={<ActivityIcon className="size-4" />}
        action={
          streaming ? (
            <span className="inline-flex items-center gap-2 text-xs font-medium text-primary-hi">
              <span className="size-2 animate-pulse rounded-full bg-primary-hi" />
              thinking…
            </span>
          ) : (
            <span className="text-xs text-faint">stream complete</span>
          )
        }
      />
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinnedRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="relative max-h-72 overflow-y-auto px-5 py-4"
      >
        {text ? (
          <pre
            className={`whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted ${
              streaming ? "caret" : ""
            }`}
          >
            {text}
          </pre>
        ) : (
          <p className="font-mono text-xs text-faint">
            Waiting for the model to respond…
          </p>
        )}
      </div>
    </Card>
  );
}
