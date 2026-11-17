import { useQuery } from '@tanstack/react-query'
import { getRepo } from '../lib/repository'

export type { SearchResults } from '../lib/repository'

/** Cross-entity search (customers, products, invoices) - the "giga search"
 *  from the Flet top bar. Runs once the term is >= 2 chars. */
export function useGlobalSearch(term: string) {
  const q = term.trim().replace(/[,()]/g, ' ')
  return useQuery({
    queryKey: ['global-search', q],
    enabled: q.length >= 2,
    queryFn: () => getRepo().globalSearch(q),
  })
}
