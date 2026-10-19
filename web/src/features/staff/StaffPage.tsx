import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { ACTIONS, RESOURCES, code, isBypassRoleName, isSuperUsername, resolveCan,
  usePermissions, useRoleGrants, useUserOverrides, useToggleRoleGrant, useSetUserOverride } from '../../data/permissions'
import { useCurrentUser, useUpdateUserRole, useUsers } from '../../data/staff'
import { useRoles } from '../../data/metadata'
import { invalidateAccess } from '../../data/refresh'
import { supabase } from '../../lib/supabase'
import { useI18n } from '../../i18n/LanguageContext'
import { useToast, useConfirm } from '../../components/Feedback'

const field = 'rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none focus:border-brand disabled:opacity-50'
const button = 'rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-50'
const message = (error: unknown) => error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)
const actionLabels: Record<string,string> = { view:'view', create:'create', edit:'edit', delete:'delete', void:'void', refund:'Refund' }

function AddUserForm({ onClose, storeId }: { onClose: () => void; storeId: string | null }) {
  const { t } = useI18n()
  const perms = usePermissions()
  const qc = useQueryClient()
  const roles = useRoles()
  const [f, setF] = useState({ username:'', full_name:'', password:'', role_id:'' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy || !perms.can('staff.create')) return
    setBusy(true); setError(null)
    try {
      const { data, error: failure } = await supabase.functions.invoke('create-user', {
        body: { ...f, username:f.username.trim(), role_id:f.role_id || null, store_id:storeId },
      })
      if (failure) {
        const response = (failure as { context?: Response }).context
        const detail = response ? await response.json().catch(() => null) : null
        throw new Error(detail?.error ?? failure.message)
      }
      if (data?.error) throw new Error(data.error)
      await invalidateAccess(qc); onClose()
    } catch (e) { setError(message(e)) } finally { setBusy(false) }
  }
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
    <form onSubmit={submit} className="w-full max-w-md space-y-3 rounded-2xl bg-white p-5 shadow-xl">
      <h2 className="text-lg font-semibold text-brand-dark">{t('New User')}</h2>
      {(['username','full_name','password'] as const).map((key,i) => <label key={key} className="block text-sm">
        {t(['Username','Full Name','Password'][i])}
        <input className={`${field} mt-1 w-full`} type={key==='password' ? 'password':'text'}
          required={key!=='full_name'} minLength={key==='password' ? 6:undefined}
          autoComplete={key==='password' ? 'new-password':'off'} value={f[key]}
          onChange={e => setF({ ...f,[key]:e.target.value })}/>
      </label>)}
      <label className="block text-sm">{t('Position')}
        <select className={`${field} mt-1 w-full`} value={f.role_id} disabled={!perms.can('staff.edit') || roles.isPending || roles.isError}
          onChange={e => setF({ ...f,role_id:e.target.value })}>
          <option value="">{t('No position — no access')}</option>
          {(roles.data ?? []).filter(r => perms.isAdmin || !isBypassRoleName(r.name)).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </label>
      <p className="text-xs text-muted">{t('A position is required before this person can use the shop.')}</p>
      {error && <p role="alert" className="text-sm text-danger">{t(error)}</p>}
      <div className="flex justify-end gap-2"><button type="button" className={field} onClick={onClose}>{t('Cancel')}</button>
        <button className={button} disabled={busy}>{t(busy ? 'Saving…':'Save')}</button></div>
    </form>
  </div>
}

function AccessControl() {
  const { t } = useI18n()
  const perms = usePermissions()
  const qc = useQueryClient()
  const roles = useRoles()
  const users = useUsers()
  const me = useCurrentUser()
  const toggle = useToggleRoleGrant()
  const override = useSetUserOverride()
  const [mode, setMode] = useState<'position'|'employee'>('position')
  const [roleSelection, setRoleSelection] = useState('')
  const [userSelection, setUserSelection] = useState('')
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const editable = (users.data ?? []).filter(u => u.id !== me.data?.id && !isSuperUsername(u.username))
  const roleId = roleSelection || roles.data?.find(r => !isBypassRoleName(r.name))?.id || roles.data?.[0]?.id || null
  const userId = userSelection || editable[0]?.id || null
  const person = editable.find(u => u.id===userId)
  const role = roles.data?.find(r => r.id===(mode==='position' ? roleId:person?.role_id))
  const grants = useRoleGrants(mode==='position' ? roleId:person?.role_id ?? null)
  const overrides = useUserOverrides(mode==='employee' ? userId:null)
  const bypass = isBypassRoleName(role?.name)
  const granted = new Set(grants.data ?? [])
  const ov = mode==='employee' ? overrides.data ?? {} : {}
  const busy = creating || toggle.isPending || override.isPending
  const unavailable = roles.isPending || users.isPending || grants.isLoading ||
    (mode==='employee' && overrides.isLoading) || roles.isError || users.isError || grants.isError ||
    (mode==='employee' && overrides.isError)
  const disabled = !perms.can('staff.edit') || bypass || busy || unavailable ||
    (mode==='position' ? !roleId:!person?.role_id || person?.is_active===false)
  async function save(c: string, value: boolean | null) {
    if (disabled) return
    setError(null); setSaved(false)
    try {
      if (mode==='position' && roleId) await toggle.mutateAsync({ roleId,permCode:c,granted:value===true })
      if (mode==='employee' && userId) await override.mutateAsync({ userId,permCode:c,allow:value })
      setSaved(true)
    } catch (e) { setError(message(e)) }
  }
  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (!newName.trim() || creating) return
    setCreating(true); setError(null); setSaved(false)
    try {
      const { data,error } = await supabase.rpc('create_staff_role',{ p_name:newName.trim() })
      if (error) throw error
      await invalidateAccess(qc); setRoleSelection(data.id); setNewName(''); setMode('position'); setSaved(true)
    } catch (e) { setError(message(e)) } finally { setCreating(false) }
  }
  return <div className="space-y-4">
    <p className="text-sm text-muted">{t('Position permissions apply to everyone in that position. Employee exceptions override them.')}</p>
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-sm">{t('Edit access for')}
        <select className={`${field} ms-2`} value={mode} onChange={e => { setMode(e.target.value as typeof mode); setSaved(false); setError(null) }}>
          <option value="position">{t('Position')}</option><option value="employee">{t('Employee')}</option>
        </select>
      </label>
      <label className="text-sm">{t(mode==='position' ? 'Position':'Employee')}
        <select className={`${field} ms-2`} value={(mode==='position' ? roleId:userId) ?? ''} disabled={busy}
          onChange={e => { (mode==='position' ? setRoleSelection:setUserSelection)(e.target.value); setSaved(false); setError(null) }}>
          {mode==='position' ? (roles.data ?? []).map(r => <option key={r.id} value={r.id}>{r.name}</option>) :
            editable.map(u => <option key={u.id} value={u.id}>{u.full_name || u.username} · {u.roles?.name || t('No position')}</option>)}
        </select>
      </label>
    </div>
    {bypass && <p className="rounded-lg bg-brand-bg p-3 text-sm">{t('Owner/admin positions always have full access.')}</p>}
    {mode==='employee' && (!person?.role_id || person.is_active===false) &&
      <p className="rounded-lg bg-warning-bg p-3 text-sm">{t('Assign an active position in Employees before setting exceptions.')}</p>}
    <p className="text-xs text-muted">{t('View is required for actions in the same area. Removing View blocks those actions without erasing their settings.')}</p>
    <p className="text-xs text-muted">{t('Staff edit manages access. Staff delete activates or deactivates employees. Customer creation and editing also apply during checkout.')}</p>
    <div className="overflow-x-auto rounded-xl border border-line bg-white">
      <table className="w-full min-w-[700px] text-sm"><thead className="bg-surface"><tr>
        <th className="p-3 text-start">{t('Area')}</th>{ACTIONS.map(a => <th key={a} className="p-2">{t(actionLabels[a])}</th>)}
      </tr></thead><tbody className="divide-y divide-line/40">
        {RESOURCES.map(r => <tr key={r.key}><th className="p-3 text-start font-medium">{t(r.label)}</th>
          {ACTIONS.map(a => {
            if (!(r.actions as readonly string[]).includes(a)) return <td key={a} className="p-2 text-center text-faint">—</td>
            const c=code(r.key,a)
            const enabledPerson = mode === 'position' || (person?.is_active === true && !!person.role_id)
            const effective = !unavailable && enabledPerson && (bypass || resolveCan(granted,ov,c))
            const selfLock = mode==='position' && roleId===me.data?.role_id && ['staff.view','staff.edit'].includes(c)
            return <td key={a} className="p-2 text-center">
              {mode==='position' ? <input type="checkbox" aria-label={`${t(r.label)}: ${t(actionLabels[a])}`}
                checked={bypass || granted.has(c)} disabled={disabled || selfLock} onChange={e => void save(c,e.target.checked)}
                className="h-4 w-4 accent-blue-600 disabled:opacity-50"/> :
                <select aria-label={`${t(r.label)}: ${t(actionLabels[a])}`} className="max-w-28 rounded border border-line bg-white p-1 text-xs disabled:opacity-50"
                  value={ov[c]===undefined ? 'inherit':ov[c] ? 'allow':'deny'} disabled={disabled}
                  onChange={e => void save(c,e.target.value==='inherit' ? null:e.target.value==='allow')}>
                  <option value="inherit">{t('Inherit')}</option><option value="allow">{t('Allowed')}</option><option value="deny">{t('Denied')}</option>
                </select>}
              <div className={`mt-1 text-[10px] ${effective ? 'text-success':'text-faint'}`}>{t(effective ? 'Allowed':'Denied')}</div>
            </td>
          })}
        </tr>)}
      </tbody></table>
    </div>
    {(error || unavailable) && <p role="alert" className="text-sm text-danger">{error ? t(error):t('Loading or unavailable permissions. Changes are disabled.')}</p>}
    <p role="status" className="text-sm text-success">{busy ? t('Saving…'):saved ? t('Saved'):''}</p>
    <form onSubmit={add} className="flex flex-wrap gap-2">
      <input aria-label={t('+ Add Position')} className={field} value={newName} onChange={e => setNewName(e.target.value)} placeholder={t('+ Add Position')}/>
      <button className={button} disabled={busy || !newName.trim()}>{t('Add')}</button>
    </form>
  </div>
}

export function StaffPage() {
  const { t } = useI18n()
  const users=useUsers(), roles=useRoles(), me=useCurrentUser(), update=useUpdateUserRole()
  const perms=usePermissions(), notify=useToast(), confirm=useConfirm()
  const [params,setParams]=useSearchParams()
  const [adding,setAdding]=useState(false)
  const canEdit=perms.can('staff.edit')
  const access=params.get('tab')==='access' && canEdit
  async function change(u: NonNullable<typeof users.data>[number], role: string | null, active: boolean) {
    if (isBypassRoleName(roles.data?.find(r=>r.id===role)?.name) && role!==u.role_id &&
      !await confirm(t('This position gives full administrator access. Continue?'))) return
    if (active!==u.is_active && !await confirm(t(active ? 'Activate this employee?':'Deactivate this employee?'))) return
    try { await update.mutateAsync({ id:u.id,role_id:role,is_active:active }); notify(t('Saved'), 'success') }
    catch(e) { notify(message(e)) }
  }
  return <div className="mx-auto max-w-5xl p-6">
    <div className="mb-4 flex items-center justify-between"><h1 className="text-2xl font-semibold text-brand-dark">{t('Staff')}</h1>
      {perms.can('staff.create') && <button className={button} onClick={()=>setAdding(true)}>{t('+ Add Staff')}</button>}
    </div>
    <div className="mb-5 flex gap-2"><button className={access ? field:button} onClick={()=>setParams({})}>{t('Employees')}</button>
      {canEdit && <button className={access ? button:field} onClick={()=>setParams({tab:'access'})}>{t('Access Control')}</button>}
    </div>
    {users.isError && <p role="alert" className="text-danger">{t("Couldn't load staff:")} {message(users.error)}</p>}
    {access ? <AccessControl/> : <div className="overflow-x-auto rounded-xl border border-line bg-white">
      <table className="w-full text-sm"><thead className="bg-surface"><tr>
        {['Username','Full Name','Position','Active'].map(h=><th key={h} className="p-3 text-start">{t(h)}</th>)}
      </tr></thead><tbody className="divide-y divide-line/40">
        {(users.data ?? []).filter(u=>!isSuperUsername(u.username)).map(u=>{
          const locked=!canEdit || u.id===me.data?.id || update.isPending || roles.isPending || roles.isError ||
            (!perms.isAdmin && isBypassRoleName(u.roles?.name))
          return <tr key={u.id}><td className="p-3 font-medium">{u.username}</td><td className="p-3">{u.full_name}</td>
            <td className="p-3"><select aria-label={`${t('Position')}: ${u.username}`} className={field} value={u.role_id ?? ''} disabled={locked}
              onChange={e=>void change(u,e.target.value || null,u.is_active===true)}>
              <option value="">{t('No position — no access')}</option>
              {(roles.data ?? []).filter(r=>perms.isAdmin || r.id===u.role_id || !isBypassRoleName(r.name)).map(r=><option key={r.id} value={r.id}>{r.name}</option>)}
            </select></td>
            <td className="p-3"><label className="flex items-center gap-2"><input type="checkbox" aria-label={`${t('Active')}: ${u.username}`}
              checked={u.is_active===true} disabled={locked || !perms.can('staff.delete')}
              onChange={e=>void change(u,u.role_id,e.target.checked)}/>{t(u.is_active ? 'Active':'Inactive')}</label></td>
          </tr>
        })}
      </tbody></table>
    </div>}
    {adding && perms.can('staff.create') && <AddUserForm storeId={me.data?.store_id ?? null} onClose={()=>setAdding(false)}/>}
  </div>
}
