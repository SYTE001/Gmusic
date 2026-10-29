import React from "react";
import type { LyricLine } from "../../types";
import { formatClock } from "../../utils/misc";

export type LyricLineItemProps = {
  index: number;
  line: LyricLine;
  isActive: boolean;
  activeWordIndex: number;
  timedLines: boolean;
  lyricsStyle: "line" | "word";
  fontSize: string;
  onSeek: (index: number) => void;
};

function arePropsEqual(prev: LyricLineItemProps, next: LyricLineItemProps): boolean {
  if (prev.index !== next.index) return false;
  if (prev.line !== next.line) return false;
  if (prev.fontSize !== next.fontSize) return false;
  if (prev.timedLines !== next.timedLines) return false;
  if (prev.lyricsStyle !== next.lyricsStyle) return false;
  if (prev.onSeek !== next.onSeek) return false;
  if (prev.isActive !== next.isActive) return false;

  // Active line in word-by-word mode re-renders when the active word changes.
  if (next.isActive && next.lyricsStyle === "word") {
    return prev.activeWordIndex === next.activeWordIndex;
  }

  // Inactive lines and active lines in line mode never re-render on word updates.
  return true;
}

export const LyricLineItem = React.memo(function LyricLineItem({
  index,
  line,
  isActive,
  activeWordIndex,
  timedLines,
  lyricsStyle,
  fontSize,
  onSeek,
}: LyricLineItemProps) {
  if (line.timeMs === null) {
    return (
      <p
        className="px-2 text-[0.92em] font-normal text-text-primary opacity-50"
        style={{ fontSize }}
      >
        {line.text || "♪"}
      </p>
    );
  }

  const hasWordData = Boolean(line.words && line.words.length > 0);
  const perWordActive = isActive && lyricsStyle === "word" && hasWordData;

  return (
    <button
      type="button"
      role={timedLines ? "listitem" : undefined}
      data-active={isActive ? "true" : undefined}
      data-line-index={index}
      onClick={() => onSeek(index)}
      aria-label={timedLines ? `${line.text} — jump to ${formatClock(line.timeMs)}` : undefined}
      className={`rounded-lg px-2 text-left font-normal text-text-primary ${
        timedLines ? "cursor-pointer" : "cursor-default"
      } ${
        isActive
          ? "opacity-100"
          : "opacity-50 hover:opacity-80"
      }`}
      style={{ fontSize }}
    >
      {perWordActive && line.words ? (
        <span>
          {line.words.map((word, wordIndex) => {
            const isWordActive = wordIndex <= activeWordIndex;
            return (
              <span
                key={wordIndex}
                className={isWordActive ? "opacity-100" : "opacity-50"}
              >
                {word.text}
              </span>
            );
          })}
        </span>
      ) : (
        <span>{line.text || "♪"}</span>
      )}
    </button>
  );
}, arePropsEqual);
