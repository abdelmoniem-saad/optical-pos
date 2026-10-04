/**
 * Which tab Inventory shows. Its own module with NO imports, for two reasons:
 * it is the one piece of the screen with a rule worth testing, and pulling the
 * component in to test it drags the whole graph - react-query, the Supabase
 * client, window - into a test that only cares about a string comparison.
 */

export type InventoryTab = 'products' | 'optical'

/**
 * Anything unrecognised - including no `tab` at all - lands on Products.
 *
 * That default is deliberate and load-bearing: every /inventory link that
 * existed before the tabs has no `?tab`, and each must keep opening the stock
 * list. It is also what makes a mistyped `?tab=opticks` show the stock list
 * rather than a blank screen - a wrong tab does not throw, it just quietly
 * shows the wrong thing, which is the failure nobody reports.
 */
export function resolveTab(raw: string | null): InventoryTab {
  return raw === 'optical' ? 'optical' : 'products'
}

/** Label is an English key on purpose: `t()` takes the English source string. */
export const INVENTORY_TABS: { key: InventoryTab; label: string }[] = [
  { key: 'products', label: 'Products' },
  { key: 'optical', label: 'Optical Settings' },
]
