import { cn } from "@/lib/utils";

interface LogoProps {
  className?: string;
  size?: number;
  showWordmark?: boolean;
}

/**
 * ChatDDB logo — a rounded square with a stylized chat bubble.
 */
export function Logo({ className, size = 28, showWordmark = false }: LogoProps) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-label="ChatDDB logo"
      >
        <rect width="32" height="32" rx="8" fill="var(--accent-primary)" />
        <path
          d="M9 11.5C9 10.1193 10.1193 9 11.5 9H20.5C21.8807 9 23 10.1193 23 11.5V17.5C23 18.8807 21.8807 20 20.5 20H15L11 23.5V20H11.5C10.1193 20 9 18.8807 9 17.5V11.5Z"
          fill="white"
        />
        <circle cx="13.5" cy="14.5" r="1.2" fill="var(--accent-primary)" />
        <circle cx="16" cy="14.5" r="1.2" fill="var(--accent-primary)" />
        <circle cx="18.5" cy="14.5" r="1.2" fill="var(--accent-primary)" />
      </svg>
      {showWordmark && (
        <span className="text-lg font-semibold tracking-tight text-[var(--text-primary)]">
          ChatDDB
        </span>
      )}
    </div>
  );
}