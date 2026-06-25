import { useUsers } from '../../data/staff'

export function StaffPage() {
  const users = useUsers()

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="mb-1 text-2xl font-semibold text-brand-dark">Staff</h1>
      <p className="mb-4 text-sm text-muted">{users.data ? `${users.data.length} users` : 'Loading…'}</p>

      <div className="mb-4 rounded-lg bg-brand-bg/50 px-3 py-2 text-sm text-brand-dark">
        New staff logins are created in Supabase Auth (dashboard, or a service-role
        Edge Function) — see <code>supabase/SETUP.md</code>. In-app staff creation
        lands in a later pass.
      </div>

      {users.isError && (
        <div className="rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">
          Couldn't load staff: {String(users.error)}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-line bg-white">
        <table className="w-full text-sm">
          <thead className="bg-surface text-left text-muted">
            <tr>
              <th className="px-4 py-2">Username</th>
              <th className="px-4 py-2">Full Name</th>
              <th className="px-4 py-2">Role</th>
              <th className="px-4 py-2 text-center">Active</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/40">
            {(users.data ?? []).length === 0 && !users.isLoading && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-faint">
                  No staff.
                </td>
              </tr>
            )}
            {(users.data ?? []).map((u) => (
              <tr key={u.id}>
                <td className="px-4 py-2 font-medium">{u.username}</td>
                <td className="px-4 py-2 text-muted">{u.full_name ?? '—'}</td>
                <td className="px-4 py-2 text-muted">{u.roles?.name ?? '—'}</td>
                <td className="px-4 py-2 text-center">
                  {u.is_active === false ? (
                    <span className="text-faint">Inactive</span>
                  ) : (
                    <span className="text-success">Active</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
