/** Stroked header icons, authored on a 24 grid and rendered at 16px. */
const svg = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true
} as const

export function IconBack(): React.JSX.Element {
  return (
    <svg {...svg}>
      <path d="m14.5 19-7-7 7-7" />
    </svg>
  )
}

export function IconForward(): React.JSX.Element {
  return (
    <svg {...svg}>
      <path d="m9.5 5 7 7-7 7" />
    </svg>
  )
}

export function IconReload(): React.JSX.Element {
  return (
    <svg {...svg}>
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <path d="M20 4v4.5h-4.5" />
    </svg>
  )
}

export function IconChevronUp(): React.JSX.Element {
  return (
    <svg {...svg}>
      <path d="m5 14.5 7-7 7 7" />
    </svg>
  )
}

export function IconChevronDown(): React.JSX.Element {
  return (
    <svg {...svg}>
      <path d="m5 9.5 7 7 7-7" />
    </svg>
  )
}

export function IconClose(): React.JSX.Element {
  return (
    <svg {...svg}>
      <path d="M6 6l12 12" />
      <path d="M18 6 6 18" />
    </svg>
  )
}

/** Clock: the recents strip. */
export function IconHistory(): React.JSX.Element {
  return (
    <svg {...svg}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  )
}

/** Key: re-mint credentials / log in again. */
export function IconKey(): React.JSX.Element {
  return (
    <svg {...svg}>
      <circle cx="7" cy="17" r="3.2" />
      <path d="M9.3 14.7 20 4" />
      <path d="m15.4 8.6 2.6 2.6" />
      <path d="m12.9 11.1 2 2" />
    </svg>
  )
}

/** Done: tool steps. */
export function IconCheck(): React.JSX.Element {
  return (
    <svg {...svg}>
      <path d="M5 12.5 9.5 17 19 7" />
    </svg>
  )
}

/** Paused on the user: a step waiting for its approval. */
export function IconPause(): React.JSX.Element {
  return (
    <svg {...svg}>
      <path d="M9 6v12" />
      <path d="M15 6v12" />
    </svg>
  )
}

/** Opens somewhere else: a table row's console link. */
export function IconExternal(): React.JSX.Element {
  return (
    <svg {...svg}>
      <path d="M14 4h6v6" />
      <path d="M20 4l-9 9" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </svg>
  )
}

/** ⋯: a row's other actions. */
export function IconMore(): React.JSX.Element {
  return (
    <svg {...svg}>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </svg>
  )
}

/** Send: the composer's button while there is text to send. */
export function IconArrowUp(): React.JSX.Element {
  return (
    <svg {...svg}>
      <path d="M12 19V5" />
      <path d="m6 11 6-6 6 6" />
    </svg>
  )
}

/** →: a suggested prompt or quick reply. */
export function IconArrowRight(): React.JSX.Element {
  return (
    <svg {...svg}>
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  )
}

/** ■: stop generating. */
export function IconStop(): React.JSX.Element {
  return (
    <svg {...svg}>
      <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
    </svg>
  )
}

/** Reads like a destructive answer (a quick reply). */
export function IconWarn(): React.JSX.Element {
  return (
    <svg {...svg}>
      <path d="M12 4 21 19.5H3z" />
      <path d="M12 10v4" />
      <path d="M12 17h.01" />
    </svg>
  )
}

/** A browser window: the current page. */
export function IconPage(): React.JSX.Element {
  return (
    <svg {...svg}>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="M3.5 9h17" />
    </svg>
  )
}
