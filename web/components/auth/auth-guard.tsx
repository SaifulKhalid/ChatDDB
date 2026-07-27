"use client";

import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/auth-context";
import { useGuestStore } from "@/stores/guest-store";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";

export function AuthGuard({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const isGuest = useGuestStore((s) => s.isGuest);
  const router = useRouter();

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-[var(--bg-primary)]">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-6 w-6 animate-spin text-[var(--accent-primary)]" />
          <span className="text-sm text-[var(--text-muted)]">Loading...</span>
        </div>
      </div>
    );
  }

  // Allow if authenticated OR in guest mode
  if (!user && !isGuest) {
    router.replace("/login");
    return null;
  }

  return <>{children}</>;
}
