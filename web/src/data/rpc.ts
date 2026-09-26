/** Shared detection for "the RPC the app just called isn't installed yet".
 *
 *  Migrations are applied by hand (web/supabase/SETUP.md), so any release can
 *  temporarily run against a database that predates the function it needs.
 *  PostgREST answers PGRST202 / 42883 / "not found in schema cache" in that
 *  case - the callers decide whether to fall back (checkout, invoice numbers)
 *  or to surface a "run the migration" notice. */
export type RpcErrorLike = {
  code?: string
  message?: string
  details?: string
  hint?: string
} | null | undefined

export function isMissingRpc(name: string, error: RpcErrorLike): boolean {
  if (!error) return false
  const code = error.code ?? ''
  // The call being made IS the named function, so these codes alone are safe.
  if (code === 'PGRST202' || code === '42883' || code === 'PGRST200' || code === '404') {
    return true
  }
  const combined = `${error.message ?? ''} ${error.details ?? ''} ${error.hint ?? ''}`
  return (
    new RegExp(name, 'i').test(combined) &&
    /(does not exist|not found|schema cache|could not find)/i.test(combined)
  )
}
