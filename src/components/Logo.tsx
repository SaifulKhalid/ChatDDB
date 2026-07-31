export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--color-accent)" />
      <path
        d="M9 11.5A4.5 4.5 0 0 1 13.5 7h5A4.5 4.5 0 0 1 23 11.5v5a4.5 4.5 0 0 1-4.5 4.5H15l-4.2 3.6c-.65.56-1.8.1-1.8-.76V11.5Z"
        fill="#fff"
      />
    </svg>
  )
}
