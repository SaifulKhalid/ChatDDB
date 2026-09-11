/**
 * The account menu in the header.
 *
 * Carries the four things that have to be reachable from every screen: who you
 * are signed in as, the admin panel (when the **D1 record** says you are an
 * admin — never a token claim), the privacy notice, and sign out.
 *
 * A plain `<details>`-free implementation: an outside-click listener and Escape,
 * which is a dozen lines and behaves correctly with the keyboard. A dropdown
 * library would be the larger dependency of the two.
 */

import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { LogOut, Shield, ShieldCheck, User as UserIcon } from 'lucide-react'
import { useAuth } from '../lib/auth'

export function UserMenu({ onOpenAdmin }: { onOpenAdmin?: () => void }) {
  const { profile, quota, imageGeneration, signOut, busy } = useAuth()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return

    const onPointerDown = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    // `pointerdown` rather than `click`: closing on mouse-down matches every
    // other menu on the platform, and avoids the case where the click lands on
    // an element that has already moved.
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (!profile) return null

  const isAdmin = profile.role === 'admin'
  const label = profile.name ?? profile.email
  const showChatQuota = quota !== null && quota.chatRemainingToday !== null
  const showImageQuota = quota !== null && imageGeneration && quota.imageRemainingToday !== null

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className="flex items-center gap-2 rounded-full p-0.5 pr-1 text-ink-2 hover:bg-surface-3 hover:text-ink"
        title={label}
      >
        <Avatar picture={profile.picture} label={label} />
        <span className="sr-only">Account menu</span>
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          className="absolute right-0 z-30 mt-2 w-64 overflow-hidden rounded-xl border border-line bg-surface shadow-lg"
        >
          <div className="flex items-center gap-3 border-b border-line px-3 py-3">
            <Avatar picture={profile.picture} label={label} size={36} />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">{label}</p>
              <p className="truncate text-xs text-ink-2">{profile.email}</p>
            </div>
          </div>

          {isAdmin && (
            <p className="flex items-center gap-1.5 border-b border-line bg-surface-2 px-3 py-2 text-xs text-ink-2">
              <ShieldCheck size={13} className="shrink-0 text-accent" aria-hidden="true" />
              Administrator
            </p>
          )}

          {/* Only shown when there is a limit to report; "0 of 0 left" would be
              a worse answer than saying nothing. The image line is additionally
              gated on `imageGeneration`, so a deployment with no `AI` binding --
              which already hides the composer's image toggle -- does not report
              a budget for something it cannot do. */}
          {quota && (showChatQuota || showImageQuota) && (
            <div className="border-b border-line px-3 py-2 text-xs text-ink-2">
              {showChatQuota && (
                <p>
                  {quota.chatRemainingToday} of {quota.chatPerDay} messages left today
                </p>
              )}
              {showImageQuota && (
                <p>
                  {quota.imageRemainingToday} of {quota.imagePerDay} images left today
                </p>
              )}
            </div>
          )}

          {isAdmin && onOpenAdmin && (
            <MenuItem
              onClick={() => {
                setOpen(false)
                onOpenAdmin()
              }}
              icon={<Shield size={15} aria-hidden="true" />}
            >
              Admin panel
            </MenuItem>
          )}

          <MenuItem
            href="/privacy.html"
            icon={<ShieldCheck size={15} aria-hidden="true" />}
            onClick={() => setOpen(false)}
          >
            Privacy notice
          </MenuItem>

          <MenuItem
            onClick={() => {
              setOpen(false)
              void signOut()
            }}
            disabled={busy}
            icon={<LogOut size={15} aria-hidden="true" />}
          >
            Sign out
          </MenuItem>
        </div>
      )}
    </div>
  )
}

function MenuItem({
  children,
  icon,
  onClick,
  href,
  disabled,
}: {
  children: ReactNode
  icon: ReactNode
  onClick?: () => void
  href?: string
  disabled?: boolean
}) {
  const className =
    'flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm text-ink hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50'

  if (href) {
    return (
      <a
        role="menuitem"
        href={href}
        target="_blank"
        rel="noreferrer"
        onClick={onClick}
        className={className}
      >
        <span className="text-ink-2">{icon}</span>
        {children}
      </a>
    )
  }
  return (
    <button role="menuitem" onClick={onClick} disabled={disabled} className={className}>
      <span className="text-ink-2">{icon}</span>
      {children}
    </button>
  )
}

/**
 * The Google profile picture, with a fallback.
 *
 * `onError` matters here rather than being defensive padding: Google's
 * `lh3.googleusercontent.com` URLs expire, and some networks block them, in
 * which case a broken-image icon would sit permanently in the header.
 */
function Avatar({
  picture,
  label,
  size = 28,
}: {
  picture: string | null
  label: string
  size?: number
}) {
  const [failed, setFailed] = useState(false)

  if (picture && !failed) {
    return (
      <img
        src={picture}
        alt=""
        width={size}
        height={size}
        onError={() => setFailed(true)}
        referrerPolicy="no-referrer"
        className="rounded-full object-cover"
        style={{ width: size, height: size }}
      />
    )
  }

  const initial = label.trim().charAt(0).toUpperCase()
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-full bg-accent font-medium text-white"
      style={{ width: size, height: size, fontSize: size * 0.42 }}
    >
      {initial || <UserIcon size={size * 0.55} />}
    </span>
  )
}
