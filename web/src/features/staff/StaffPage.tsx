import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  ACTIONS,
  RESOURCES,
  code,
  useRoleGrants,
  useSetUserOverride,
  useToggleRoleGrant,
  useUserOverrides,
} from '../../data/permissions'
import { useUpdateUserRole, useUsers } from '../../data/staff'
import { useRoles } from '../../data/metadata'
import { supabase } from '../../lib/supabase'
import { useI18n } from '../../i18n/LanguageContext'
import { usePermissions } from '../../data/permissions'
import type { NamedRow } from '../../data/metadata'

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
          <input className={cls} placeholder={t('Password')} type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
          <select className={cls} value={roleId} onChange={(e) => setF({ ...f, role_id: e.target.value })}>
            {(roles.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </div>
        {err && <div className="mt-2 rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">{t(err)}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-line px-4 py-2 text-muted hover:bg-surface">{t('Cancel')}</button>
          <button onClick={submit} disabled={busy} className="rounded-lg bg-brand px-4 py-2 font-semibold text-white disabled:opacity-60">{busy ? t('Saving…') : t('Save')}</button>
        </div>
      </div>
    </div>
  )
}

/** Checkbox cell for a position's grant. */
function GrantCell({
  granted,
  onToggle,
}: {
  granted: boolean | undefined
  onToggle: (next: boolean) => void
}) {
  return (
    <input
      type="checkbox"
      checked={!!granted}
      onChange={(e) => onToggle(e.target.checked)}
      className="h-4 w-4 accent-[#1976d2]"
    />
  )
}

/** Tri-state cell for a person: — inherit · ✓ allowed · ✕ denied (click cycles). */
function OverrideCell({
  state,
  onCycle,
}: {
  state: boolean | undefined
  onCycle: () => void
}) {
  const cls =
    state === undefined
      ? 'text-faint hover:text-brand-dark'
      : state
        ? 'font-bold text-success'
        : 'font-bold text-danger'
  return (
    <button onClick={onCycle} className={`mx-auto block h-6 w-6 rounded-md hover:bg-surface ${cls}`}>
      {state === undefined ? '—' : state ? '✓' : '✕'}
    </button>
  )
}

function PermissionMatrix({
  grants,
  overrides,
  onToggleGrant,
  onCycleOverride,
}: {
  grants?: Set<string> | string[]
  overrides?: Record<string, boolean>
  onToggleGrant?: (permCode: string, next: boolean) => void
  onCycleOverride?: (permCode: string) => void
}) {
  const { t } = useI18n()
  const has = (c: string) =>
    overrides ? overrides[c] : grants ? (grants instanceof Set ? grants.has(c) : grants.includes(c)) : false

  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-white">
      <table className="w-full min-w-[560px] text-sm">
        <thead className="bg-surface text-muted">
          <tr>
            <th className="px-3 py-2 text-start font-medium">{t('Staff')}</th>
            {ACTIONS.map((a) => (
              <th key={a} className="px-3 py-2 text-center font-medium">{t(a)}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line/40">
          {RESOURCES.map((r) => (
            <tr key={r.key} className="hover:bg-surface/40">
              <td className="px-3 py-1.5">{t(r.label)}</td>
              {ACTIONS.map((a) => {
                const c = code(r.key, a)
                return (
                  <td key={a} className="px-3 py-1.5 text-center">
                    {onToggleGrant ? (
                      <GrantCell granted={has(c)} onToggle={(next) => onToggleGrant(c, next)} />
                    ) : (
                      <OverrideCell state={overrides?.[c]} onCycle={() => onCycleOverride?.(c)} />
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Per-position grant editor + per-person override editor. */
function AccessControl() {
  const { t } = useI18n()
  const qc = useQueryClient()
  const roles = useRoles()
  const users = useUsers()

  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null)
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null)
  const [newPosition, setNewPosition] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const roleId = selectedRoleId ?? roles.data?.[0]?.id ?? null
  const userId = selectedUserId ?? users.data?.[0]?.id ?? null

  const grants = useRoleGrants(roleId)
  const overrides = useUserOverrides(userId)
  const toggleGrant = useToggleRoleGrant()
  const setOverride = useSetUserOverride()

  async function addPosition() {
    const name = newPosition.trim()
    if (!name) return
    setErr(null)
    const { data, error } = await supabase.from('roles').insert({ name }).select().single<NamedRow>()
    if (error) {
      setErr(error.message)
      return
    }
    await qc.invalidateQueries({ queryKey: ['roles'] })
    setNewPosition('')
    setSelectedRoleId(data.id)
  }

  const selCls = 'rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand'

  return (
    <div className="space-y-6">
      {/* ---- position grants ---- */}
      <section>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="font-semibold text-brand-dark">{t('Position')}</h3>
          <select className={selCls} value={roleId ?? ''} onChange={(e) => setSelectedRoleId(e.target.value)}>
            {(roles.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
          <input
            value={newPosition}
            onChange={(e) => setNewPosition(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addPosition()}
            placeholder={t('+ Add Position')}
            className="w-44 rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand"
          />
          <button
            onClick={addPosition}
            disabled={!newPosition.trim()}
            className="rounded-lg border border-line px-3 py-2 text-sm text-muted hover:bg-surface disabled:opacity-50"
          >
            {t('Add')}
          </button>
        </div>

        {/* Ticked = the position can do it. Unticked = blocked for everyone in
            this position, unless a person below has an explicit ✓. */}
        <PermissionMatrix
          grants={grants.data}
          onToggleGrant={(permCode, next) =>
            roleId && toggleGrant.mutate({ roleId, permCode, granted: next })
          }
        />
        {grants.isError && (
          <p className="mt-2 rounded-lg bg-warning-bg px-3 py-2 text-xs text-warning">
            {String(grants.error)}
          </p>
        )}
      </section>

      {/* ---- per-person overrides ---- */}
      <section>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="font-semibold text-brand-dark">{t('Employee')}</h3>
          <select className={selCls} value={userId ?? ''} onChange={(e) => setSelectedUserId(e.target.value)}>
            {(users.data ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.full_name || u.username} — {u.username}
              </option>
            ))}
          </select>
          <span className="flex flex-wrap items-center gap-3 text-xs text-faint">
            <span><span className="inline-block w-4 text-center">—</span> {t('Inherit')}</span>
            <span className="text-success"><span className="inline-block w-4 text-center font-bold">✓</span> {t('Allowed')}</span>
            <span className="text-danger"><span className="inline-block w-4 text-center font-bold">✕</span> {t('Denied')}</span>
          </span>
        </div>

        <PermissionMatrix
          overrides={overrides.data}
          onCycleOverride={(permCode) => {
            if (!userId) return
            const current = overrides.data?.[permCode]
            const next = current === undefined ? true : current === true ? false : null
            setOverride.mutate({ userId, permCode, allow: next })
          }}
        />
        {overrides.isError && (
          <p className="mt-2 rounded-lg bg-warning-bg px-3 py-2 text-xs text-warning">
            {String(overrides.error)}
          </p>
        )}
      </section>

      {err && <p className="rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">{t(err)}</p>}
    </div>
  )
}

export function StaffPage() {
  const { t } = useI18n()
  const users = useUsers()
  const roles = useRoles()
  const updateRole = useUpdateUserRole()
  const perms = usePermissions()
  const [adding, setAdding] = useState(false)
  const [tab, setTab] = useState<'people' | 'access'>('people')

  const canEditStaff = perms.isAdmin || perms.can('staff.edit' as never)

  const tabBtn = (key: 'people' | 'access', label: string) => (
    <button
      key={key}
      onClick={() => setTab(key)}
      className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${
        tab === key ? 'bg-brand text-white' : 'bg-surface text-muted hover:bg-line/30'
      }`}
    >
      {label}
    </button>
  )

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-brand-dark">{t('Staff')}</h1>
        {canEditStaff && (
          <button onClick={() => setAdding(true)} className="rounded-lg bg-brand px-4 py-2.5 font-semibold text-white">
            {t('+ Add Staff')}
          </button>
        )}
      </div>

      <div className="mb-5 mt-3 flex gap-2">
        {tabBtn('people', t('Employees'))}
        {canEditStaff && tabBtn('access', t('Access Control'))}
      </div>

      {tab === 'people' ? (
        <>
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
                        disabled={!canEditStaff}
                        onChange={(e) => updateRole.mutate({ id: u.id, role_id: e.target.value || null })}
                        className="rounded-lg border border-line bg-white px-2 py-1 text-sm outline-none focus:border-brand disabled:opacity-60"
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
        </>
      ) : (
        <AccessControl />
      )}

      {adding && <AddUserForm onClose={() => setAdding(false)} />}
    </div>
  )
}
