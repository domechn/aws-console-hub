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
