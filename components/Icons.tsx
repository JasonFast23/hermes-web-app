import { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function base(props: IconProps) {
  return {
    xmlns: "http://www.w3.org/2000/svg",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    ...props,
  };
}

export function SkillsIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M14.7 6.3a4 4 0 1 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2-2z" />
    </svg>
  );
}

export function MenuIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

export function PhoneIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 5c0-.6.4-1 1-1h2.8c.5 0 .9.3 1 .8l1 3.8c.1.4 0 .9-.4 1.2L7.9 11a12 12 0 0 0 5 5l1.2-1.5c.3-.4.8-.5 1.2-.4l3.8 1c.5.1.8.5.8 1V19c0 .6-.4 1-1 1h-1.5C10.6 20 4 13.4 4 6.5V5z" />
    </svg>
  );
}

export function MessagingIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M21 11.5a8.5 8.5 0 0 1-11.7 7.9L4 21l1.6-5.3A8.5 8.5 0 1 1 21 11.5z" />
    </svg>
  );
}

export function ArtifactsIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

export function AgentsIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 2 3 6v6c0 5 4 8.5 9 10 5-1.5 9-5 9-10V6z" />
      <path d="M9.5 12.5c.6.7 1.5 1 2.5 1s1.9-.3 2.5-1" />
      <path d="M9 9.5h.01M15 9.5h.01" />
    </svg>
  );
}

export function SpeakerIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <polygon points="4 9 8 9 12 5 12 19 8 15 4 15 4 9" />
      <path d="M16 8a5 5 0 0 1 0 8" />
    </svg>
  );
}

export function SpeakerMutedIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <polygon points="4 9 8 9 12 5 12 19 8 15 4 15 4 9" />
      <line x1="15.5" y1="9" x2="20.5" y2="15" />
      <line x1="20.5" y1="9" x2="15.5" y2="15" />
    </svg>
  );
}

export function BellIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 3a4 4 0 0 0-4 4v3.2c0 .9-.35 1.77-.98 2.4L5 14.7h14l-2.02-2.1a3.4 3.4 0 0 1-.98-2.4V7a4 4 0 0 0-4-4z" />
      <path d="M9.5 17.7a2.5 2.5 0 0 0 5 0" />
    </svg>
  );
}

export function BellOffIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 3a4 4 0 0 0-4 4v3.2c0 .9-.35 1.77-.98 2.4L5 14.7h14l-2.02-2.1a3.4 3.4 0 0 1-.98-2.4V7a4 4 0 0 0-4-4z" />
      <path d="M9.5 17.7a2.5 2.5 0 0 0 5 0" />
      <line x1="4" y1="4" x2="20" y2="20" />
    </svg>
  );
}

export function AccountIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </svg>
  );
}

export function InfoIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16.5" />
      <circle cx="12" cy="7.75" r="0.1" fill="currentColor" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.5-2-3.4-2.3.9a7.6 7.6 0 0 0-2.6-1.5L14 2.5h-4l-.5 2.5a7.6 7.6 0 0 0-2.6 1.5l-2.3-.9-2 3.4L4.6 10.5a7.6 7.6 0 0 0 0 3l-2 1.5 2 3.4 2.3-.9c.76.66 1.64 1.18 2.6 1.5L10 21.5h4l.5-2.5a7.6 7.6 0 0 0 2.6-1.5l2.3.9 2-3.4z" />
    </svg>
  );
}

export function PanelToggleIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="14" y1="4" x2="14" y2="20" />
    </svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function MicIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

export function WaveformIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <line x1="4" y1="10" x2="4" y2="14" />
      <line x1="8" y1="7" x2="8" y2="17" />
      <line x1="12" y1="4" x2="12" y2="20" />
      <line x1="16" y1="7" x2="16" y2="17" />
      <line x1="20" y1="10" x2="20" y2="14" />
    </svg>
  );
}

export function ArrowUpIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  );
}

export function StopIcon(props: IconProps) {
  return (
    <svg {...base(props)} fill="currentColor" stroke="none">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

export function CommandIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M9 3a2.5 2.5 0 0 0 0 5h1V6a2.5 2.5 0 0 0-1-3z" />
      <path d="M15 3a2.5 2.5 0 0 1 0 5h-1V6a2.5 2.5 0 0 1 1-3z" />
      <path d="M9 21a2.5 2.5 0 0 1 0-5h1v2a2.5 2.5 0 0 1-1 3z" />
      <path d="M15 21a2.5 2.5 0 0 0 0-5h-1v2a2.5 2.5 0 0 0 1 3z" />
      <rect x="8" y="8" width="8" height="8" rx="1" />
    </svg>
  );
}

export function SignalIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <line x1="4" y1="20" x2="4" y2="16" />
      <line x1="10" y1="20" x2="10" y2="12" />
      <line x1="16" y1="20" x2="16" y2="8" />
      <line x1="22" y1="20" x2="22" y2="4" />
    </svg>
  );
}

export function SparkleIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
      <path d="M12 8a4 4 0 0 0 4 4 4 4 0 0 0-4 4 4 4 0 0 0-4-4 4 4 0 0 0 4-4z" />
    </svg>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15.5 14" />
    </svg>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 7h16" />
      <path d="M9 7V4.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V7" />
      <path d="M6 7l1 12.5a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5L18 7" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <polyline points="5 12.5 9.5 17 19 6.5" />
    </svg>
  );
}

export function XIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function PaperclipIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M18.5 10.5 L11 18a4 4 0 0 1-5.5-5.5l8-8a2.7 2.7 0 0 1 3.8 3.8l-7.8 7.8a1.3 1.3 0 0 1-1.9-1.9l6.7-6.7" />
    </svg>
  );
}

export function FileIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

export function FlagIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M5 21V4a1 1 0 0 1 1-1h11.5a1 1 0 0 1 .8 1.6l-3 4 3 4a1 1 0 0 1-.8 1.6H6" />
    </svg>
  );
}
