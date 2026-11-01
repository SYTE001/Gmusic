import React from "react";
import type { LyricLine } from "../../types";

export type LyricLineItemProps = {
  line: LyricLine;
  fontSize: string;
};

/**
 * Static line of plain (unsynchronized) lyrics. Timed lyrics are rendered and
 * animated by the AMLL player instead (see AmllLyricPlayer).
 */
export const LyricLineItem = React.memo(function LyricLineItem({ line, fontSize }: LyricLineItemProps) {
  return (
    <p className="px-2 text-[0.92em] font-normal text-text-primary opacity-50" style={{ fontSize }}>
      {line.text || "♪"}
    </p>
  );
});
