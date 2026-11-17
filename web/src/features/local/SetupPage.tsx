import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useI18n } from '../../i18n/LanguageContext'
import { usernameToEmail } from '../../lib/auth'
import { useLocalMeta } from '../../lib/local/state'
import { provisionDevice } from '../../lib/local/sync'

/**
 * First run on the shop PC (local mode): link this computer to the store with
 * an admin's cloud account and download all data. Needs internet ONCE; after
 * this the POS runs fully offline and replicates to the cloud when it can.
 */
export function SetupPage() {
  const { t, lang, toggle } = useI18n()
  const navigate = useNavigate()
  const meta = useLocalMeta()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (meta.provisioned) return <Navigate to="/" replace />

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!username || !password) {
      setError('Enter username and password')
      return
    }
    if (!navigator.onLine) {
      setError('Setup needs an internet connection (only this once).')
      return
    }
    setBusy(true)
    try {
      await provisionDevice(usernameToEmail(username), password, (table, done, total) =>
        setProgress(table ? `${t('Downloading')} ${table} (${done + 1}/${total})` : t('Finishing…')),
      )
      navigate('/login', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setProgress(null)
    } finally {
      setBusy(false)
    }
  }

  const cls = 'w-full rounded-lg border border-line px-3 py-2.5 outline-none focus:border-brand'

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-md rounded-2xl bg-white p-8 shadow-lg">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-xl bg-brand text-2xl font-bold text-white">
            L
          </div>
          <h1 className="text-xl font-semibold text-brand-dark">{t('Set up this computer')}</h1>
          <p className="mt-2 text-sm text-muted">
            {t(
              'Sign in once with the store admin account. All data is downloaded to this computer so it keeps working without internet.',
            )}
          </p>
        </div>

        {error && <div className="mb-4 rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">{t(error)}</div>}

        <label className="mb-3 block">
          <span className="mb-1 block text-sm font-medium text-muted">{t('Username')}</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            autoComplete="username"
            disabled={busy}
            className={cls}
          />
        </label>
        <label className="mb-5 block">
          <span className="mb-1 block text-sm font-medium text-muted">{t('Password')}</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            disabled={busy}
            className={cls}
          />
        </label>

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-brand py-2.5 font-semibold text-white transition hover:bg-brand-dark disabled:opacity-60"
        >
          {busy ? t('Setting up…') : t('Link and download data')}
        </button>
        {progress && <p className="mt-3 text-center text-xs text-muted">{progress}</p>}

        <button
          type="button"
          onClick={toggle}
          className="mt-4 w-full text-center text-xs text-faint hover:text-muted"
        >
          {lang === 'ar' ? 'English' : 'العربية'}
        </button>
      </form>
    </div>
  )
}
