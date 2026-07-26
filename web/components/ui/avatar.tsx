import * as React from "react";
import { cn } from "@/lib/utils";

interface AvatarProps extends React.HTMLAttributes<HTMLDivElement> {
  fallback?: string;
  src?: string;
  size?: "sm" | "md" | "lg";
}

export function Avatar({
  className,
  fallback,
  src,
  size = "md",
  ...props
}: AvatarProps) {
  const sizes = {
    sm: "h-7 w-7 text-xs",
    md: "h-8 w-8 text-sm",
    lg: "h-10 w-10 text-base",
  };
  return (
    <div
      className={cn(
        "relative flex shrink-0 items-center justify-center rounded-full bg-[var(--accent-primary)] font-semibold text-white overflow-hidden",
        sizes[size],
        className
      )}
      {...props}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={fallback || "avatar"} className="h-full w-full object-cover" />
      ) : (
        <span>{fallback?.charAt(0).toUpperCase() || "U"}</span>
      )}
    </div>
  );
}