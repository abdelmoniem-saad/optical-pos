import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useUpdateUserRole, useUsers } from '../../data/staff'
import { useRoles } from '../../data/metadata'
import { supabase } from '../../lib/supabase'
import { useI18n } from '../../i18n/LanguageContext'

function AddUserForm({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const qc = useQueryClient()
  const roles = useRoles()
  const [f, setF] = useState({ username: '', full_name: '', password: '', role_id: '' })
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const cls = 'w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand'
  const roleId = f.role_id || roles.data?.[0]?.id || ''

  async function submit() {
    setErr(null)
    if (!f.username.trim() || f.password.length < 6) {
      setErr(t('Username is required') + ' · ' + t('Password must be at least 6 characters'))
      return
    }
    setBusy(true)
    try {
      const { data, error } = await supabase.functions.invoke('create-user', {
        body: {
          username: f.username.trim(),
          password: f.password,
          full_name: f.full_name.trim(),
          role_id: roleId || null,
        },
      })
      if (error) {
        // supabase-js wraps non-2xx as a generic message; the real reason is in
        // the response body (error.context is the Response). Pull it out.
        let detail = error.message
        const ctx = (error as { context?: Response }).context
        if (ctx && typeof ctx.json === 'function') {
          try {
            const b = await ctx.json()
            if (b?.error) detail = b.error
          } catch {
            /* body wasn't JSON */
          }
        }
        throw new Error(detail)
      }
      if (data?.error) throw new Error(data.error)
      await qc.invalidateQueries({ queryKey: ['users'] })
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
        <h2 className="mb-3 text-lg font-semibold text-brand-dark">{t('New User')}</h2>
        <div className="space-y-2">
          <input className={cls} placeholder={t('Username')} value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} />
          <input className={cls} placeholder={t('Full Name')} value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} />
          <input className={cls} type="password" placeholder={t('Password')} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
          <select className={cls} value={roleId} onChange={(e) => setF({ ...f, role_id: e.target.value })}>
            {(roles.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </div>
        {err && <div className="mt-2 rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">{t(err)}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-line px-4 py-2 text-muted hover:bg-surface">{t('Cancel')}</button>
          <button onClick={submit} disabled={busy} className="rounded-lg bg-brand px-4 py-2 font-semibold text-white disabled:opacity-60">
            {busy ? t('Saving…') : t('Save')}
          </button>
        </div>
      </div>
    </div>
  )
}

export function StaffPage() {
  const { t } = useI18n()
  const users = useUsers()
  const roles = useRoles()
  const updateRole = useUpdateUserRole()
  const [adding, setAdding] = useState(false)

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-brand-dark">{t('Staff')}</h1>
        <button onClick={() => setAdding(true)} className="rounded-lg bg-brand px-4 py-2.5 font-semibold text-white">
          {t('+ Add Staff')}
        </button>
      </div>
      <p className="mb-4 text-sm text-muted">
        {users.data ? `${users.data.length} ${t('users')}` : t('Loading…')}
      </p>

      {users.isError && (
        <div className="rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">
          {t("Couldn't load staff:")} {String(users.error)}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-line bg-white">
        <table className="w-full text-sm">
          <thead className="bg-surface text-start text-muted">
            <tr>
              <th className="px-4 py-2">{t('Username')}</th>
              <th className="px-4 py-2">{t('Full Name')}</th>
              <th className="px-4 py-2">{t('Role')}</th>
              <th className="px-4 py-2 text-center">{t('Active')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/40">
            {(users.data ?? []).length === 0 && !users.isLoading && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-faint">
                  {t('No staff.')}
                </td>
              </tr>
            )}
            {(users.data ?? []).map((u) => (
              <tr key={u.id}>
                <td className="px-4 py-2 font-medium">{u.username}</td>
                <td className="px-4 py-2 text-muted">{u.full_name ?? '—'}</td>
                <td className="px-4 py-2">
                  <select
                    value={u.role_id ?? ''}
                    onChange={(e) => updateRole.mutate({ id: u.id, role_id: e.target.value || null })}
                    className="rounded-lg border border-line bg-white px-2 py-1 text-sm outline-none focus:border-brand"
                  >
                    {(roles.data ?? []).map((r) => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-2 text-center">
                  {u.is_active === false ? (
                    <span className="text-faint">{t('Inactive')}</span>
                  ) : (
                    <span className="text-success">{t('Active')}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {adding && <AddUserForm onClose={() => setAdding(false)} />}
    </div>
  )
}
