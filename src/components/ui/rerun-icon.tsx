/**
 * The rerun mark — go round again, and play. Not the retry's bare circular
 * arrow, since the two do different things (this one rolls a new seed and loads
 * the form; the retry repeats a failed run exactly), and not the Remix loop it
 * sits beside on the stage. In one place because the stage and the history row
 * both draw it.
 */
export function RerunIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`shrink-0 ${className}`}
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3h-3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M6.75 5.9v4.2L10.2 8 6.75 5.9Z" fill="currentColor" />
    </svg>
  );
}
