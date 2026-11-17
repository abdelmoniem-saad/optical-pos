import { useState } from 'react'
import { useI18n } from '../../i18n/LanguageContext'
import { usernameToEmail } from '../../lib/auth'
import { useLocalMeta } from '../../lib/local/state'
import { linkDevice, skipBlockedEntry, syncNow, useSyncStatus, type SyncStatus } from '../../lib/local/sync'
import { usePermissions } from '../../data/permissions'

function tone(s: SyncStatus): { dot: string; label: string } {
  if (s.blocked || s.needsLink) return { dot: 'bg-danger', label: 'Sync problem' }
  if (!s.online) return { dot: 'bg-faint', label: 'Offline' }
  if (s.syncing) return { dot: 'bg-brand animate-pulse', label: 'Syncing…' }
  if (s.pending || s.pendingImages) return { dot: 'bg-warning', label: 'Waiting to sync' }
  return { dot: 'bg-success', label: 'Synced' }
}

function when(iso: string | null, t: (k: string) => string): string {
  if (!iso) return t('never')
  const d = new Date(iso)
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

/** Sidebar chip: replication health at a glance; click for details. */
export function SyncBadge() {
  const { t } = useI18n()
  const s = useSyncStatus()
  const [open, setOpen] = useState(false)
  const { dot, label } = tone(s)
  const waiting = s.pending + s.pendingImages
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 rounded-lg border border-line px-3 py-2 text-start text-xs text-muted hover:bg-surface"
        title={t('Cloud sync')}
      >
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} />
        <span className="truncate">
          {t(label)}
          {waiting > 0 && ` · ${waiting}`}
        </span>
      </button>
      {open && <SyncPanel onClose={() => setOpen(false)} />}
    </>
  )
}

function SyncPanel({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const s = useSyncStatus()
  const meta = useLocalMeta()
  const perms = usePermissions()
  const [busy, setBusy] = useState(false)
  const row = 'flex justify-between gap-4 py-1.5 text-sm'

  async function skip() {
    if (!confirm(t('Skip this change? It will NOT reach the cloud copy (it stays on this computer).'))) return
    setBusy(true)
    try {
      await skipBlockedEntry()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-1 text-lg font-semibold text-brand-dark">{t('Cloud sync')}</h2>
        <p className="mb-3 text-xs text-muted">
          {t('This computer is the main copy. Changes upload to the cloud (owner phone view and off-site backup) whenever there is internet.')}
        </p>

        <div className="divide-y divide-line/40 rounded-lg border border-line px-3">
          <div className={row}>
            <span className="text-muted">{t('Status')}</span>
            <span className="font-medium">{t(tone(s).label)}</span>
          </div>
          <div className={row}>
            <span className="text-muted">{t('Internet')}</span>
            <span>{s.online ? t('Connected') : t('Offline')}</span>
          </div>
          <div className={row}>
            <span className="text-muted">{t('Changes waiting')}</span>
            <span className="rcpt-num">{s.pending}</span>
          </div>
          <div className={row}>
            <span className="text-muted">{t('Photos waiting')}</span>
            <span className="rcpt-num">{s.pendingImages}</span>
          </div>
          <div className={row}>
            <span className="text-muted">{t('Last sync')}</span>
            <span>{when(s.lastSyncAt, t)}</span>
          </div>
          <div className={row}>
            <span className="text-muted">{t('Cloud account')}</span>
            <span className="truncate" dir="ltr">
              {meta.deviceAccount ?? '-'}
            </span>
          </div>
        </div>

        {s.lastError && !s.blocked && (
          <p className="mt-3 rounded-lg bg-warning-bg px-3 py-2 text-xs text-warning">{t(s.lastError)}</p>
        )}

        {s.blocked && (
          <div className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
            <div className="mb-1 font-semibold">
              {t('The cloud rejected a change - later changes are waiting behind it.')}
            </div>
            <div dir="ltr" className="break-words">
              {s.blocked.op} {s.blocked.table}: {s.blocked.error}
            </div>
            <div className="mt-1 text-faint">
              {t('Attempts')}: {s.blocked.attempts} · {when(s.blocked.createdAt, t)}
            </div>
            {perms.isAdmin && (
              <button
                onClick={skip}
                disabled={busy}
                className="mt-2 rounded-md border border-danger/40 px-2 py-1 text-danger hover:bg-white disabled:opacity-50"
              >
                {t('Skip this change')}
              </button>
            )}
          </div>
        )}

        {s.needsLink && <RelinkForm />}

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-line px-4 py-2 text-sm text-muted hover:bg-surface">
            {t('Close')}
          </button>
          <button
            onClick={() => void syncNow(true)}
            disabled={s.syncing || !s.online}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {s.syncing ? t('Syncing…') : t('Sync now')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** The device account's cloud session expired/revoked: an admin signs in again. */
function RelinkForm() {
  const { t } = useI18n()
  const [u, setU] = useState('')
  const [p, setP] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const cls = 'w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand'

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    setBusy(true)
    try {
      await linkDevice(usernameToEmail(u), p)
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-2 rounded-lg border border-line p-3">
      <div className="text-xs font-semibold text-brand-dark">
        {t('Sign in again with the store admin account to resume cloud sync.')}
      </div>
      <input className={cls} placeholder={t('Username')} value={u} onChange={(e) => setU(e.target.value)} autoComplete="username" />
      <input
        className={cls}
        type="password"
        placeholder={t('Password')}
        value={p}
        onChange={(e) => setP(e.target.value)}
        autoComplete="current-password"
      />
      {err && <div className="text-xs text-warning">{t(err)}</div>}
      <button disabled={busy} className="w-full rounded-lg bg-brand py-2 text-sm font-semibold text-white disabled:opacity-60">
        {busy ? t('Signing in…') : t('Sign in')}
      </button>
    </form>
  )
}
