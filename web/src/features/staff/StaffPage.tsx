import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  ACTIONS,
  RESOURCES,
  code,
  isBypassRoleName,
  isSuperUsername,
  useRoleGrants,
  useSetUserOverride,
  useToggleRoleGrant,
  useUserOverrides,
} from '../../data/permissions'
import { useCurrentUser, useUpdateUserRole, useUsers } from '../../data/staff'
import { useRoles } from '../../data/metadata'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'
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

/** Codes that could lock the editor out of this very page. */
const SENSITIVE_CODES = ['staff.view', 'staff.edit']

/** Checkbox cell for a position's grant. */
function GrantCell({
  granted,
  disabled,
  onToggle,
}: {
  granted: boolean | undefined
  disabled?: boolean
  onToggle: (next: boolean) => void
}) {
  return (
    <input
      type="checkbox"
      checked={!!granted}
      disabled={disabled}
      onChange={(e) => onToggle(e.target.checked)}
      className="h-4 w-4 accent-[#1976d2] disabled:opacity-50"
    />
  )
}

/**
 * Tri-state cell for a person: — inherit · ✓ allowed · ✕ denied.
 * The background always shows the EFFECTIVE result after combining the
 * position default with this exception (green = can, red = cannot).
 */
function OverrideCell({
  state,
  effective,
  disabled,
  onCycle,
}: {
  state: boolean | undefined
  effective: boolean
  disabled?: boolean
  onCycle: () => void
}) {
  const { t } = useI18n()
  // Inherit renders EMPTY — the green/red background already tells whether the
  // person can actually do this. No dash glyphs anywhere.
  const glyph =
    state === undefined ? '' : state ? '✓' : '✕'
  const glyphCls =
    state === undefined
      ? 'text-faint'
      : state
        ? 'font-bold text-success'
        : 'font-bold text-danger'
  const title =
    (state === undefined
      ? `${t('Inherit')} → `
      : state
        ? `${t('Allowed')} → `
        : `${t('Denied')} → `) + (effective ? t('Allowed') : t('Denied'))
  return (
    <button
      onClick={onCycle}
      disabled={disabled}
      title={title}
      className={`mx-auto flex h-6 w-9 items-center justify-center rounded-md border ${
        effective ? 'border-success/40 bg-success-bg' : 'border-danger/30 bg-danger/10'
      } ${glyphCls} ${disabled ? 'opacity-60' : 'hover:brightness-95'}`}
    >
      {glyph}
    </button>
  )
}

function PermissionMatrix({
  grants,
  overrides,
  roleGrantsForEffective,
  disabled,
  onToggleGrant,
  onCycleOverride,
}: {
  grants?: Set<string> | string[]
  overrides?: Record<string, boolean>
  /** Position grants of the SELECTED PERSON — used to tint effective results. */
  roleGrantsForEffective?: string[]
  disabled?: boolean
  onToggleGrant?: (permCode: string, next: boolean) => void
  onCycleOverride?: (permCode: string) => void
}) {
  const { t } = useI18n()
  const isRoleMatrix = !!onToggleGrant

  const roleHas = (c: string) =>
    grants ? (grants instanceof Set ? grants.has(c) : grants.includes(c)) : false

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
            <tr key={r.key}>
              <td className="px-3 py-1.5">{t(r.label)}</td>
              {ACTIONS.map((a) => {
                const c = code(r.key, a)
                if (isRoleMatrix) {
                  return (
                    <td key={a} className="px-3 py-1.5 text-center">
                      <GrantCell
                        granted={roleHas(c)}
                        disabled={disabled}
                        onToggle={(next) => onToggleGrant?.(c, next)}
                      />
                    </td>
                  )
                }
                const state = overrides?.[c]
                const effective = state !== undefined ? state : roleGrantsForEffective?.includes(c) ?? false
                return (
                  <td key={a} className="px-3 py-1.5 text-center">
                    <OverrideCell
                      state={state}
                      effective={effective}
                      disabled={disabled}
                      onCycle={() => onCycleOverride?.(c)}
                    />
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
  const me = useCurrentUser()
  const { user } = useAuth()

  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null)
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null)
  const [newPosition, setNewPosition] = useState('')
  const [err, setErr] = useState<string | null>(null)

  // The reserved super-admin account and YOUR OWN row are never editable here.
  // Exclusion matches by id AND username, so it holds even while the staff
  // record lookup is still resolving (or if it links through a legacy row).
  const myUsername = user?.email?.split('@')[0]?.toLowerCase() ?? ''
  const isSelfRow = (u: { id: string; username: string | null }) =>
    (me.data?.id && u.id === me.data.id) ||
    (!!myUsername && (u.username ?? '').toLowerCase() === myUsername)
  const editableUsers = (users.data ?? []).filter(
    (u) => !isSelfRow(u) && !isSuperUsername(u.username),
  )

  const roleId = selectedRoleId ?? roles.data?.[0]?.id ?? null
  const userId = selectedUserId ?? editableUsers[0]?.id ?? null

  const selectedRole = roles.data?.find((r) => r.id === roleId)
  // Each card depends ONLY on its own selection:
  //   card 1 disables when the selected POSITION bypasses,
  //   card 2 when the selected EMPLOYEE is an owner/admin or the super admin.
  const bypass = isBypassRoleName(selectedRole?.name)

  const grants = useRoleGrants(roleId)
  const overrides = useUserOverrides(userId)

  // The selected person's position defaults — needed to show effective colors.
  const selUser = users.data?.find((u) => u.id === userId)
  const userRoleGrants = useRoleGrants(selUser?.role_id ?? null)
  const empBypass =
    !!selUser && (isBypassRoleName(selUser.roles?.name) || isSuperUsername(selUser.username))

  const toggleGrant = useToggleRoleGrant()
  const setOverride = useSetUserOverride()

  const editingSelfRole = !!me.data?.role_id && roleId === me.data.role_id

  /** Guard: warn before an action could lock the editor out of THIS page. */
  function guardSelfLockout(permCode: string, willDeny: boolean): boolean {
    if (!willDeny || !SENSITIVE_CODES.includes(permCode)) return true
    if (editingSelfRole && roleId === me.data?.role_id) {
      return window.confirm(t('This may lock you out of the Staff page. Continue?'))
    }
    return true
  }

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
    <div className="space-y-8">
      {/* ---- position grants (the DEFAULTS) ---- */}
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

        {bypass && (
          <div className="mb-2 rounded-lg bg-brand-bg px-3 py-2 text-xs font-semibold text-brand-dark">
            {t('Owner/admin positions always have full access.')}
          </div>
        )}
        <p className="mb-2 text-xs text-muted">{t('Defaults for everyone in this position.')}</p>

        <PermissionMatrix
          grants={grants.data}
          disabled={bypass}
          onToggleGrant={(permCode, next) => {
            if (!guardSelfLockout(permCode, !next)) return
            if (roleId) toggleGrant.mutate({ roleId, permCode, granted: next })
          }}
        />
        {grants.isError && (
          <p className="mt-2 rounded-lg bg-warning-bg px-3 py-2 text-xs text-warning">
            {String(grants.error)}
          </p>
        )}
      </section>

      {/* ---- per-person EXCEPTIONS ---- */}
      <section>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="font-semibold text-brand-dark">{t('Employee')}</h3>
          {editableUsers.length === 0 ? (
            <span className="text-sm text-faint">{t('No staff.')}</span>
          ) : (
            <select className={selCls} value={userId ?? ''} onChange={(e) => setSelectedUserId(e.target.value)}>
              {editableUsers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name || u.username} — {u.username}
                </option>
              ))}
            </select>
          )}
        </div>

        {empBypass ? (
          <div className="mb-2 rounded-lg bg-brand-bg px-3 py-2 text-xs font-semibold text-brand-dark">
            {t(
              'This person is an owner/admin, they always have full access, so there is nothing to configure.',
            )}
          </div>
        ) : (
          <>
            <p className="mb-2 text-xs text-muted">
              {t(
                'Exceptions for this person, click to cycle: follow position → allowed (✓) → blocked (✕).',
              )}
            </p>

            <PermissionMatrix
              overrides={overrides.data}
              roleGrantsForEffective={userRoleGrants.data}
              onCycleOverride={(permCode) => {
                if (!userId) return
                const current = overrides.data?.[permCode]
                const next: boolean | null =
                  current === undefined ? true : current === true ? false : null
                setOverride.mutate({ userId, permCode, allow: next })
              }}
            />
          </>
        )}
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
  const me = useCurrentUser()
  const updateRole = useUpdateUserRole()
  const perms = usePermissions()
  const [adding, setAdding] = useState(false)
  const [tab, setTab] = useState<'people' | 'access'>('people')

  // The reserved super-admin account is infrastructure, not an employee row.
  const people = (users.data ?? []).filter((u) => !isSuperUsername(u.username))
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
            {users.data ? `${people.length} ${t('users')}` : t('Loading…')}
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
                {people.length === 0 && !users.isLoading && (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-faint">
                      {t('No staff.')}
                    </td>
                  </tr>
                )}
                {people.map((u) => (
                  <tr key={u.id}>
                    <td className="px-4 py-2 font-medium">{u.username}</td>
                    <td className="px-4 py-2 text-muted">{u.full_name ?? '—'}</td>
                    <td className="px-4 py-2">
                      <select
                        value={u.role_id ?? ''}
                        disabled={!canEditStaff || u.id === me.data?.id}
                        title={
                          u.id === me.data?.id
                            ? t('You are changing your own access, be careful!')
                            : undefined
                        }
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
