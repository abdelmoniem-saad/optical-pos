import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { useI18n } from '../../i18n/LanguageContext'
import { useIsPlatformAdmin } from '../../lib/licensing'

type StoreRow = {
  id: string
  name: string
  owner_name: string | null
  owner_phone: string | null
  created_at: string | null
  store_licenses:
    | { id: string; plan: string; expires_at: string | null; is_revoked: boolean }[]
    | null
}

/**
 * VENDOR control panel (platform admins only): create stores, issue/renew
 * licenses, and spin up each store's first admin login via the create-user
 * Edge Function. Completely separate from store staff and permissions.
 */
export function PlatformPage() {
  const { t } = useI18n()
  const qc = useQueryClient()
  const isPlatform = useIsPlatformAdmin()
  const [err, setErr] = useState<string | null>(null)
  const [form, setForm] = useState({
    name: '',
    owner_name: '',
    owner_phone: '',
    owner_email: '',
    plan: 'standard',
    admin_username: '',
    admin_password: '',
  })

  const stores = useQuery({
    queryKey: ['platform-stores'],
    enabled: isPlatform,
    queryFn: async (): Promise<StoreRow[]> => {
      const { data, error } = await supabase
        .from('stores')
        .select('*, store_licenses(*)')
        .order('created_at')
        .returns<StoreRow[]>()
      if (error) throw error
      return data ?? []
    },
  })

  async function createStore() {
    setErr(null)
    const name = form.name.trim()
    const adminUsername = form.admin_username.trim()
    const adminPassword = form.admin_password
    if (!name || !adminUsername || form.admin_password.length < 6) {
      setErr(t('Store name and admin login (6+ chars) are required'))
      return
    }
    try {
      const { data: store, error: sErr } = await supabase
        .from('stores')
        .insert({
          name,
          owner_name: form.owner_name || null,
          owner_phone: form.owner_phone || null,
          owner_email: form.owner_email || null,
        })
        .select()
        .single<{ id: string }>()
      if (sErr) throw sErr

      // License by plan: trial = 14 days, paid plans = 1 year (renewable).
      const days = form.plan === 'trial' ? 14 : 365
      const expires = new Date(Date.now() + days * 86_400_000).toISOString()
      const { error: lErr } = await supabase.from('store_licenses').insert({
        store_id: store.id,
        license_key:
          'STORE-' + store.id.slice(0, 8) + '-' + Math.random().toString(36).slice(2, 6).toUpperCase(),
        plan: form.plan,
        expires_at: expires,
      })
      if (lErr) throw lErr

      // Per-store positions: Admin (full access) + Seller (empty until configured).
      const { data: perms } = await supabase
        .from('permissions')
        .select('id')
        .returns<{ id: string }[]>()
      const { data: adminRole, error: rErr } = await supabase
        .from('roles')
        .insert({ name: 'Admin', store_id: store.id })
        .select()
        .single<{ id: string }>()
      if (rErr) throw rErr
      await supabase.from('roles').insert({ name: 'Seller', store_id: store.id })
      if (perms?.length) {
        await supabase
          .from('role_permissions')
          .insert(perms.map((p) => ({ role_id: adminRole.id, permission_id: p.id })))
      }

      // The store's first admin login (service-role, same as Staff page).
      const { error: uErr } = await supabase.functions.invoke('create-user', {
        body: {
          username: adminUsername,
          password: adminPassword,
          full_name: form.owner_name || adminUsername,
          role_id: adminRole.id,
          store_id: store.id,
        },
      })
      if (uErr) {
        const ctx = (uErr as { context?: Response }).context
        if (ctx && typeof ctx.json === 'function') {
          try {
            const b = await ctx.json()
            if (b?.error) throw new Error(b.error)
          } catch (e) {
            if (e instanceof Error && e.message !== 'Failed to fetch') throw e
          }
        }
        throw uErr
      }

      await qc.invalidateQueries({ queryKey: ['platform-stores'] })
      setForm({ name: '', owner_name: '', owner_phone: '', owner_email: '', plan: 'standard', admin_username: '', admin_password: '' })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  if (isPlatform === false) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <div className="rounded-xl bg-warning-bg px-4 py-3 text-sm font-semibold text-warning">
          🚫 {t('Platform access only')}
        </div>
      </div>
    )
  }

  const field =
    'w-full rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand'

  return (
    <div className="mx-auto max-w-4xl p-6">
      <h1 className="mb-1 text-2xl font-semibold text-brand-dark">{t('Platform')}</h1>
      <p className="mb-4 text-sm text-muted">{t('Stores')}</p>

      {err && (
        <div className="mb-3 rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">{err}</div>
      )}

      {/* ---- create store ---- */}
      <div className="mb-6 rounded-xl border border-line bg-white p-4 shadow-sm">
        <h2 className="mb-3 font-semibold text-brand-dark">{t('Create store')}</h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <input
            className={field}
            placeholder={t('Store name')}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <input
            className={field}
            placeholder={t('Owner name')}
            value={form.owner_name}
            onChange={(e) => setForm({ ...form, owner_name: e.target.value })}
          />
          <input
            className={field}
            placeholder={t('Owner phone')}
            value={form.owner_phone}
            onChange={(e) => setForm({ ...form, owner_phone: e.target.value })}
          />
          <input
            className={field}
            placeholder={t('Owner email')}
            value={form.owner_email}
            onChange={(e) => setForm({ ...form, owner_email: e.target.value })}
          />
          <select
            className={field}
            value={form.plan}
            onChange={(e) => setForm({ ...form, plan: e.target.value })}
          >
            <option value="trial">{t('trial')}</option>
            <option value="standard">{t('standard')}</option>
            <option value="pro">{t('pro')}</option>
          </select>
          <input
            className={field}
            placeholder={t('Store admin username')}
            value={form.admin_username}
            onChange={(e) => setForm({ ...form, admin_username: e.target.value })}
          />
          <input
            className={`${field} sm:col-span-2`}
            type="password"
            placeholder={t('Store admin password')}
            value={form.admin_password}
            onChange={(e) => setForm({ ...form, admin_password: e.target.value })}
          />
        </div>
        <button
          onClick={createStore}
          className="mt-3 rounded-lg bg-brand px-5 py-2 text-sm font-semibold text-white disabled:opacity-60"
          disabled={!form.name.trim() || !form.admin_username.trim() || form.admin_password.length < 6}
        >
          {t('Create store')}
        </button>
      </div>

      {/* ---- stores list ---- */}
      <div className="overflow-hidden rounded-xl border border-line bg-white shadow-sm">
        {(stores.data?.length ?? 0) === 0 ? (
          <p className="p-4 text-sm text-faint">{t('No stores yet.')}</p>
        ) : (
          <ul className="divide-y divide-line/40">
            {(stores.data ?? []).map((s) => {
              const lic = s.store_licenses?.[0]
              return (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <div>
                    <div className="font-semibold">{s.name}</div>
                    <div className="text-xs text-faint">
                      {(s.created_at ?? '').slice(0, 10)}
                      {lic ? ` · ${lic.plan}` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                        lic && !lic.is_revoked && (!lic.expires_at || lic.expires_at > new Date().toISOString())
                          ? 'bg-success-bg text-success'
                          : 'bg-danger/10 text-danger'
                      }`}
                    >
                      {lic?.is_revoked
                        ? t('Revoked')
                        : lic?.expires_at
                          ? `${t('Expires')}: ${lic.expires_at.slice(0, 10)}`
                          : t('No license')}
                    </span>
                    <input
                      type="date"
                      value={lic?.expires_at?.slice(0, 10) ?? ''}
                      onChange={(e) => {
                        if (!e.target.value) return
                        void supabase
                          .from('store_licenses')
                          .update({ expires_at: e.target.value, is_revoked: false })
                          .eq('id', lic!.id)
                          .then(() => stores.refetch())
                      }}
                      className="rounded-md border border-line px-2 py-1 text-xs"
                    />
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
