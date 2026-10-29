/**
 * Original inline SVG icon set — 24x24 grid, stroke-based, no external icon
 * dependency (rules §11: bundle assets locally). Every icon is drawn for this
 * project; none are copied from an icon library or the reference app.
 */
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base(size: number | undefined, props: SVGProps<SVGSVGElement>) {
  return {
    width: size ?? 20,
    height: size ?? 20,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    ...props,
  };
}

export function PlayIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function PauseIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <rect x="6.5" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none" />
      <rect x="13.9" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function NextIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M6 6v12l8.5-6z" fill="currentColor" stroke="none" />
      <path d="M17.5 6v12" />
    </svg>
  );
}

export function PrevIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M18 6v12l-8.5-6z" fill="currentColor" stroke="none" />
      <path d="M6.5 6v12" />
    </svg>
  );
}

export function ShuffleIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M3 7h3.5c1.2 0 2.3.6 3 1.6l4 5.8c.7 1 1.8 1.6 3 1.6H20" />
      <path d="M3 16h3.5c1.2 0 2.3-.6 3-1.6l.9-1.3" />
      <path d="M14.6 8.9l.9-1.3c.7-1 1.8-1.6 3-1.6H20" />
      <path d="M18 4l2.5 2.5L18 9" />
      <path d="M18 15l2.5 2.5L18 20" />
    </svg>
  );
}

export function RepeatIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M17 3.5l2.5 2.5L17 8.5" />
      <path d="M19.5 6H7.5A3.5 3.5 0 0 0 4 9.5v1" />
      <path d="M7 20.5L4.5 18 7 15.5" />
      <path d="M4.5 18h12a3.5 3.5 0 0 0 3.5-3.5v-1" />
    </svg>
  );
}

export function RepeatOneIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M17 3.5l2.5 2.5L17 8.5" />
      <path d="M19.5 6H7.5A3.5 3.5 0 0 0 4 9.5v1" />
      <path d="M7 20.5L4.5 18 7 15.5" />
      <path d="M4.5 18h12a3.5 3.5 0 0 0 3.5-3.5v-1" />
      <path d="M11.4 10.5l1.6-1v5" strokeWidth={1.6} />
    </svg>
  );
}

export function HeartIcon({ size, filled, ...props }: IconProps & { filled?: boolean }) {
  return (
    <svg {...base(size, props)} fill={filled ? "currentColor" : "none"}>
      <path d="M12 20s-7.5-4.6-7.5-10A4.4 4.4 0 0 1 9 5.6c1.3 0 2.4.6 3 1.6.6-1 1.7-1.6 3-1.6a4.4 4.4 0 0 1 4.5 4.4c0 5.4-7.5 10-7.5 10z" />
    </svg>
  );
}

export function VolumeIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M4 9.5h3l4.5-3.8v12.6L7 14.5H4z" fill="currentColor" stroke="none" />
      <path d="M15 9.2a4 4 0 0 1 0 5.6" />
      <path d="M17.6 6.8a7.5 7.5 0 0 1 0 10.4" />
    </svg>
  );
}

export function VolumeMuteIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M4 9.5h3l4.5-3.8v12.6L7 14.5H4z" fill="currentColor" stroke="none" />
      <path d="M15.5 9.5l5 5" />
      <path d="M20.5 9.5l-5 5" />
    </svg>
  );
}

export function QueueIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M4 6h11" />
      <path d="M4 11h11" />
      <path d="M4 16h7" />
      <path d="M17.5 12.5v7" />
      <circle cx="15.2" cy="19.5" r="2.2" fill="currentColor" stroke="none" />
      <path d="M17.5 12.5l3.5 1.3v2.2" />
    </svg>
  );
}

export function SearchIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l5 5" />
    </svg>
  );
}

export function HomeIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M4.5 10.5L12 4l7.5 6.5V20h-5v-5.5h-5V20h-5z" />
    </svg>
  );
}

export function LibraryIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <rect x="4" y="4" width="3.4" height="16" rx="1" />
      <rect x="10.3" y="4" width="3.4" height="16" rx="1" />
      <path d="M17.6 5.2l2.8 14.6" />
    </svg>
  );
}

export function PlaylistIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M4 6.5h11" />
      <path d="M4 11.5h11" />
      <path d="M4 16.5h7" />
      <circle cx="17.5" cy="17" r="2.5" fill="currentColor" stroke="none" />
      <path d="M20 17V8.5l-3 1" />
    </svg>
  );
}

export function SettingsIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2.2M12 18.3v2.2M4.9 7.8l1.9 1.1M17.2 15.1l1.9 1.1M4.9 16.2l1.9-1.1M17.2 8.9l1.9-1.1" />
    </svg>
  );
}

export function PlusIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function MoreIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function CloseIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function LyricsIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M8 9.5h8M8 13h8M8 16.5h4.5" />
    </svg>
  );
}

export function ChevronDownIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M6 9.5l6 6 6-6" />
    </svg>
  );
}

export function ChevronUpIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M6 14.5l6-6 6 6" />
    </svg>
  );
}

export function ChevronLeftIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M14.5 6l-6 6 6 6" />
    </svg>
  );
}

export function ChevronRightIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M9.5 6l6 6-6 6" />
    </svg>
  );
}

export function FolderIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2.5h8A1.5 1.5 0 0 1 20.5 9.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" />
    </svg>
  );
}

export function MusicNoteIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <circle cx="7.5" cy="17.5" r="2.8" />
      <path d="M10.3 17.5V5.5l9-2v10.2" />
      <circle cx="16.5" cy="15" r="2.8" />
    </svg>
  );
}

export function ImportIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M12 4v10" />
      <path d="M8 10l4 4 4-4" />
      <path d="M5 18.5h14" />
    </svg>
  );
}

export function ClockIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

export function CheckIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

export function WarningIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M12 4.5L2.8 19.5h18.4z" />
      <path d="M12 10v4" />
      <circle cx="12" cy="16.8" r="0.4" fill="currentColor" />
    </svg>
  );
}

export function TrashIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M4.5 7h15" />
      <path d="M9.5 7V5h5v2" />
      <path d="M6.5 7l1 12.5h9L17.5 7" />
      <path d="M10.2 10.5v6M13.8 10.5v6" />
    </svg>
  );
}

export function EditIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M14.5 5.5l4 4L8 20H4v-4z" />
      <path d="M12.5 7.5l4 4" />
    </svg>
  );
}

export function ExpandIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M9 4.5H4.5V9" />
      <path d="M15 4.5h4.5V9" />
      <path d="M9 19.5H4.5V15" />
      <path d="M15 19.5h4.5V15" />
    </svg>
  );
}

export function GripIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <circle cx="9" cy="6.5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="15" cy="6.5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="9" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="9" cy="17.5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="15" cy="17.5" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function LinkIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1.5-1.5" />
    </svg>
  );
}

export function OfflineIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M5 12.5a7 7 0 0 1 14 0" />
      <path d="M8.5 15.5a4 4 0 0 1 7 0" />
      <circle cx="12" cy="18.5" r="0.6" fill="currentColor" />
      <path d="M4 5l16 16" />
    </svg>
  );
}

export function CloudIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M7 18a4.5 4.5 0 0 1 .5-8.97A5.5 5.5 0 0 1 18 10.5a3.5 3.5 0 0 1-.5 6.96" />
    </svg>
  );
}

export function CloudCheckIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <path d="M7 18a4.5 4.5 0 0 1 .5-8.97A5.5 5.5 0 0 1 18 10.5a3.5 3.5 0 0 1-.5 6.96" />
      <path d="M9.5 15.5l2 2 3.5-4" />
    </svg>
  );
}

export function InfoIcon({ size, ...props }: IconProps) {
  return (
    <svg {...base(size, props)}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 11v5" />
      <circle cx="12" cy="8" r="0.5" fill="currentColor" />
    </svg>
  );
}
