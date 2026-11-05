import React from "react";
import type { LyricLine } from "../../types";

export type LyricLineItemProps = {
  line: LyricLine;
  fontSize: string;
};

/**
 * Static line of plain (unsynchronized) lyrics. Uses `--lyric-inactive` (>= 3:1 contrast)
 * directly rather than a fixed low opacity.
 */
export const LyricLineItem = React.memo(function LyricLineItem({ line, fontSize }: LyricLineItemProps) {
  return (
    <p
      className="px-2 text-[0.92em] font-normal"
      style={{
        fontSize,
        color: "var(--lyric-inactive, var(--text-secondary))",
      }}
    >
      {line.text || "♪"}
    </p>
  );
});
