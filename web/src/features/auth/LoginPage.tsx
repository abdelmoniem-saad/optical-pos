import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../lib/auth'
import { useI18n } from '../../i18n/LanguageContext'

/** Real Supabase Auth login. Staff enter a username; the AuthProvider maps it
 *  to an email behind the scenes. A full email also works. */
export function LoginPage() {
  const { t, lang, toggle } = useI18n()
  const navigate = useNavigate()
  const { signIn } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!username || !password) {
      setError('Enter username and password')
      return
    }
    setBusy(true)
    try {
      await signIn(username, password)
      navigate('/', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-lg"
      >
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-xl bg-brand text-2xl font-bold text-white">
            L
          </div>
          <h1 className="text-xl font-semibold text-brand-dark">LensyPOS</h1>
          <p className="text-sm text-muted">{t('Sign in to continue')}</p>
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">
            {t(error)}
          </div>
        )}

        <label className="mb-3 block">
          <span className="mb-1 block text-sm font-medium text-muted">{t('Username')}</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            autoComplete="username"
            className="w-full rounded-lg border border-line px-3 py-2.5 outline-none focus:border-brand"
          />
        </label>

        <label className="mb-5 block">
          <span className="mb-1 block text-sm font-medium text-muted">{t('Password')}</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            className="w-full rounded-lg border border-line px-3 py-2.5 outline-none focus:border-brand"
          />
        </label>

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-brand py-2.5 font-semibold text-white transition hover:bg-brand-dark disabled:opacity-60"
        >
          {busy ? t('Signing in…') : t('Sign in')}
        </button>

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
