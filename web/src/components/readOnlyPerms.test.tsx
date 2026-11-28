// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

/**
 * Offline-v2 Phase 1 (design 2.8): when a store records on its register PC,
 * my_permissions() answers read_only (033). Every write gate on the phone must
 * then evaluate false with no change at the call site, the shell says why,
 * and only the owner keeps the Revoke register / Switch off levers.
 *
 * Each component is rendered twice through the REAL PermissionsProvider: once
 * as today's admin (the write controls are there, so the probe can see them),
 * once read-only (they are gone or disabled). The first half is also the
 * "inert" proof: without read_only nothing changes.
 */
const m = vi.hoisted(() => ({
  perms: {} as Record<string, unknown>,
  rpcCalls: [] as { name: string; args: unknown }[],
  tables: {} as Record<string, unknown[]>,
  rpcData: {} as Record<string, unknown>,
}))

function thenable(result: () => { data: unknown; error: unknown; count?: number }, first: () => unknown): unknown {
  const self: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') {
        return (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, bad)
      }
      if (prop === 'maybeSingle' || prop === 'single') {
        return () => Promise.resolve({ data: first(), error: null })
      }
      return () => self
    },
  })
  return self
}

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: (table: string) => thenable(
      () => ({ data: m.tables[table] ?? [], error: null, count: (m.tables[table] ?? []).length }),
      () => (m.tables[table] ?? [])[0] ?? null,
    ),
    rpc: (name: string, args?: unknown) => {
      m.rpcCalls.push({ name, args })
      const data = name === 'my_permissions' ? m.perms : m.rpcData[name] ?? null
      return thenable(() => ({ data, error: null }), () => (Array.isArray(data) ? data[0] ?? null : data))
    },
    storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: 'https://x/y.jpg' } }) }) },
    auth: { getSession: async () => ({ data: { session: { user: { id: 'owner-1' } } } }) },
    functions: { invoke: vi.fn() },
  },
}))
vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    user: { id: 'owner-1' },
    session: { user: { id: 'owner-1' } },
    loading: false,
    signOut: vi.fn(),
    signIn: vi.fn(),
  }),
  displayName: () => 'Owner',
}))

import { LanguageProvider } from '../i18n/LanguageContext'
import { FeedbackProvider } from './Feedback'
import { PermissionsProvider } from '../data/permissions'
import { ALL_CODES } from '../data/permissionModel'
import { AppLayout } from './AppLayout'
import { ReadOnlyBanner } from './ReadOnlyBanner'
import { VoidSaleButton } from '../features/history/VoidSaleButton'
import { SalePayments } from '../features/history/SalePayments'
import { SettingsPage } from '../features/settings/SettingsPage'
import { OpticalSettings } from '../features/inventory/OpticalSettings'
import { NotesPage } from '../features/notes/NotesPage'
import { SuppliersPage } from '../features/suppliers/SuppliersPage'
import { StaffPage } from '../features/staff/StaffPage'
import type { Sale } from '../lib/database.types'

/** Today's store admin: every code, admin bypass, no 033 fields at all. */
const ADMIN = { is_admin: true, active: true, assigned: true, codes: ALL_CODES }
/** What 033 answers for the owner of a register_only store. */
const READ_ONLY_OWNER = {
  is_admin: false, active: true, assigned: true, read_only: true, is_owner: true,
  codes: ALL_CODES.filter((c) => c.endsWith('.view')),
}
const READ_ONLY_STAFF = { ...READ_ONLY_OWNER, is_owner: false }
/** Defence in depth: even an answer that still carried write codes and
 *  is_admin (a stale or wrong server) shows nothing writable when read_only. */
const READ_ONLY_LEAKY = { ...ADMIN, read_only: true, is_owner: false }

const SALE = {
  id: 'sale-1', invoice_no: '1001', voided_at: null, net_amount: 500, amount_paid: 100,
  rx_image_path: null, frame_image_path: null, lab_status: null, customer_id: null,
} as unknown as Sale

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  // jsdom has no layout; AppLayout scrolls its pane to the top on navigation.
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.setItem('lensy-lang', 'en')
  m.rpcCalls = []
  m.tables = {
    users: [
      { id: 'owner-1', username: 'owner', full_name: 'Owner', is_active: true, role_id: 'r-admin', store_id: 'store-1', roles: { name: 'Admin' } },
      { id: 'cash-1', username: 'mona', full_name: 'Mona', is_active: true, role_id: 'r-cash', store_id: 'store-1', roles: { name: 'Cashier' } },
    ],
    roles: [{ id: 'r-admin', name: 'Admin' }, { id: 'r-cash', name: 'Cashier' }],
    lens_types: [{ id: 'l1', name: 'Single Vision', sort_order: 1 }],
    frame_colors: [{ id: 'c1', name: 'Black', sort_order: 1 }],
    suppliers: [{ id: 'sup-1', name: 'Acme' }],
    // One shipment of Acme's, not yet received, with one payment: opening it
    // mounts Receive (:132), delete payment (:170), add payment (:199) and
    // + Add Shipment, the gates the list alone never renders.
    purchases: [{ id: 'pur-1', supplier_id: 'sup-1', total_amount: 1000, amount_paid: 0, purchase_date: '2026-11-10T10:00:00Z' }],
    purchase_items: [{ id: 'pi-1', purchase_id: 'pur-1', product_id: 'prod-1', qty: 2, unit_cost: 500, total_cost: 1000, received_at: null }],
    purchase_payments: [{ id: 'pp-1', purchase_id: 'pur-1', amount: 200, paid_at: '2026-11-11', note: null }],
    sale_payments: [{ id: 'p1', sale_id: 'sale-1', amount: 100, method: 'cash', paid_at: '2026-11-01T10:00:00Z' }],
    settings: [{ key: 'shop_name', value: 'Lensy' }],
    // The owner's own notes, one private and one to everyone, so NoteCard
    // renders and the per-note canEdit / canDelete gates (NotesPage.tsx:221,
    // :224) actually run.
    notes: [
      { id: 'n-mine', body: 'Call the lab', user_id: 'owner-1', created_by: 'owner-1', created_at: '2026-11-20T10:00:00Z', updated_at: null },
      { id: 'n-all', body: 'Closing early', user_id: null, created_by: 'owner-1', created_at: '2026-11-21T10:00:00Z', updated_at: null },
    ],
  }
  m.rpcData = {
    my_license_state: { state: 'active', plan: 'pro', expires_at: null, store_name: 'Shop' },
    is_platform_admin: false,
    auth_store_id: 'store-1',
    register_status: { last_ingest_at: '2026-11-27T09:30:00Z', pending_reported: 3 },
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  localStorage.clear()
})

async function settle() {
  for (let i = 0; i < 8; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  }
}

/** A fresh root per render, so nothing carries over from the previous one. */
function freshRoot() {
  act(() => root.unmount())
  root = createRoot(container)
}

async function render(perms: Record<string, unknown>, node: ReactNode, path = '/') {
  freshRoot()
  m.perms = perms
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() => {
    root.render(
      <QueryClientProvider client={qc}>
        <LanguageProvider>
          <FeedbackProvider>
            <MemoryRouter initialEntries={[path]}>
              <PermissionsProvider>{node}</PermissionsProvider>
            </MemoryRouter>
          </FeedbackProvider>
        </LanguageProvider>
      </QueryClientProvider>,
    )
  })
  await settle()
}

/** Labels of buttons that change data. Navigation, view toggles and Cancel
 *  are not writes; the owner's two levers are checked on their own. */
const WRITE_TEXT = /(Void|Add Payment|Refund|Save|\bAdd\b|Delete|✕|Edit|\+ Add|Receive into stock)/

/** Every control in the tree that could still write: an enabled, editable
 *  field, or an enabled button whose label is a write. */
function writeControls(): string[] {
  const out: string[] = []
  for (const el of container.querySelectorAll('input, textarea, select')) {
    const f = el as HTMLInputElement
    if (f.disabled || f.readOnly || f.type === 'hidden') continue
    out.push(`${el.tagName.toLowerCase()}[${f.getAttribute('aria-label') ?? f.placeholder ?? f.name}]`)
  }
  for (const el of container.querySelectorAll('button')) {
    const b = el as HTMLButtonElement
    const label = `${b.textContent ?? ''} ${b.title ?? ''}`.trim()
    if (!b.disabled && WRITE_TEXT.test(label)) out.push(`button[${label}]`)
  }
  return out
}

const buttonsNamed = (name: string) =>
  [...container.querySelectorAll('button')].filter((b) => (b.textContent ?? '').includes(name))

/** Click the first button whose text contains `name`, then let it settle. */
async function clickButton(name: string) {
  const b = buttonsNamed(name)[0]
  expect(b, `button "${name}"`).toBeTruthy()
  act(() => b.click())
  await settle()
}

type Gated = {
  name: string
  make: () => ReactNode
  /** Write controls an admin must see, by label: each names a gate the
   *  read-only runs below then prove closed, so dropping that gate fails. */
  adminSees: RegExp[]
  /** Brings the deeper gates on screen (a selected supplier, an open card). */
  open?: () => Promise<void>
}

const GATED: Gated[] = [
  { name: 'VoidSaleButton', make: () => <VoidSaleButton sale={SALE} />, adminSees: [/Void/] },
  { name: 'SalePayments', make: () => <SalePayments sale={SALE} balance={400} />, adminSees: [/Add Payment|Refund/] },
  { name: 'SettingsPage', make: () => <SettingsPage />, adminSees: [/Save/] },
  { name: 'OpticalSettings', make: () => <OpticalSettings />, adminSees: [/Add|Delete|✕/] },
  {
    name: 'NotesPage',
    make: () => <NotesPage />,
    // canEdit (:224) and canDelete (:221) on the owner's own notes, plus the
    // composer (canCreate).
    adminSees: [/^button\[✎ Edit\]$/, /^button\[Delete\]$/, /^textarea\[/],
  },
  {
    name: 'SuppliersPage',
    make: () => <SuppliersPage />,
    adminSees: [
      /^button\[\+ Add Supplier\]$/,
      /^button\[\+ Add Shipment\]$/,
      /^button\[Receive into stock\]$/,
      /^button\[Add Payment\]$/,
      /^button\[✕ Delete\]$/,
      /^input\[Amount Paid\]$/,
    ],
    open: async () => {
      await clickButton('Acme')
      await clickButton('▼')
    },
  },
  { name: 'StaffPage', make: () => <StaffPage />, adminSees: [/Add|Save|Delete|Edit/] },
]

describe('read-only phone view: no write controls on the gated components', () => {
  for (const { name, make, adminSees, open } of GATED) {
    it(`${name}: an admin today sees write controls (inert without read_only)`, async () => {
      await render(ADMIN, make())
      await open?.()
      const found = writeControls()
      for (const want of adminSees) {
        expect(found.some((c) => want.test(c)), `${want} in ${JSON.stringify(found)}`).toBe(true)
      }
    })

    it(`${name}: read-only owner sees none`, async () => {
      await render(READ_ONLY_OWNER, make())
      await open?.()
      expect(writeControls()).toEqual([])
    })

    it(`${name}: read_only wins even over write codes and is_admin`, async () => {
      await render(READ_ONLY_LEAKY, make())
      await open?.()
      expect(writeControls()).toEqual([])
    })
  }

  it('NotesPage: the owner still confirms a note as seen (note_seen is not guarded, design 4.3)', async () => {
    await render(READ_ONLY_OWNER, <NotesPage />)
    expect(buttonsNamed('Mark as seen').length).toBeGreaterThan(0)
  })

  it('SuppliersPage: the read-only owner can still open a shipment and read it', async () => {
    await render(READ_ONLY_OWNER, <SuppliersPage />)
    await clickButton('Acme')
    await clickButton('▼')
    expect(container.textContent).toContain('Shipments - Acme')
    expect(container.textContent).toContain('+200.00')
  })
})

describe('read-only shell', () => {
  async function renderShell(perms: Record<string, unknown>) {
    freshRoot()
    m.perms = perms
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    act(() => {
      root.render(
        <QueryClientProvider client={qc}>
          <LanguageProvider>
            <FeedbackProvider>
              <MemoryRouter initialEntries={['/customers']}>
                <Routes>
                  <Route path="/" element={<AppLayout />}>
                    <Route path="customers" element={<div>customers</div>} />
                  </Route>
                </Routes>
              </MemoryRouter>
            </FeedbackProvider>
          </LanguageProvider>
        </QueryClientProvider>,
      )
    })
    await settle()
  }

  const navLabels = () => [...container.querySelectorAll('nav a')].map((a) => a.textContent)

  it('shows the banner and hides the POS when read_only', async () => {
    await renderShell(READ_ONLY_STAFF)
    expect(container.textContent).toContain('Read-only: the shop PC is the system of record')
    expect(navLabels()).not.toContain('New Sale')
    expect(navLabels()).toContain('History')
  })

  it('shows neither banner nor change without read_only (today)', async () => {
    await renderShell(ADMIN)
    expect(container.textContent).not.toContain('Read-only')
    expect(navLabels()).toContain('New Sale')
    expect(m.rpcCalls.map((c) => c.name)).not.toContain('register_status')
  })
})

describe('owner-only levers', () => {
  it('Revoke register is offered to the owner only', async () => {
    await render(READ_ONLY_OWNER, <ReadOnlyBanner />)
    expect(buttonsNamed('Revoke register')).toHaveLength(1)

    await render(READ_ONLY_STAFF, <ReadOnlyBanner />)
    expect(container.textContent).toContain('Read-only')
    expect(buttonsNamed('Revoke register')).toHaveLength(0)

    await render(ADMIN, <ReadOnlyBanner />)
    expect(container.textContent).toBe('')
  })

  it('the owner sees when the PC last synced and what is waiting', async () => {
    await render(READ_ONLY_OWNER, <ReadOnlyBanner />)
    expect(container.textContent).toContain('Last sync')
    expect(container.textContent).toContain('Waiting on the PC: 3')
  })

  it('the freshness line hides when register_status is not there', async () => {
    m.rpcData.register_status = null
    await render(READ_ONLY_OWNER, <ReadOnlyBanner />)
    expect(container.textContent).not.toContain('Last sync')
    expect(buttonsNamed('Revoke register')).toHaveLength(1)
  })

  it('Revoke asks first, then calls revoke_register for the owner\'s store', async () => {
    await render(READ_ONLY_OWNER, <ReadOnlyBanner />)
    act(() => buttonsNamed('Revoke register')[0].click())
    await settle()
    expect(m.rpcCalls.map((c) => c.name)).not.toContain('revoke_register')
    // The confirm dialog's own button carries the same label; it is the last.
    const confirmBtn = buttonsNamed('Revoke register').at(-1)!
    act(() => confirmBtn.click())
    await settle()
    expect(m.rpcCalls.find((c) => c.name === 'revoke_register')?.args).toEqual({ p_store: 'store-1' })
  })

  it('Switch off appears on other active staff for the owner only', async () => {
    await render(READ_ONLY_OWNER, <StaffPage />)
    expect(buttonsNamed('Switch off')).toHaveLength(1) // mona, never the owner himself

    await render(READ_ONLY_STAFF, <StaffPage />)
    expect(buttonsNamed('Switch off')).toHaveLength(0)

    await render(ADMIN, <StaffPage />)
    expect(buttonsNamed('Switch off')).toHaveLength(0)
  })

  it('Switch off asks first, then queues owner_deactivate_staff', async () => {
    await render(READ_ONLY_OWNER, <StaffPage />)
    act(() => buttonsNamed('Switch off')[0].click())
    await settle()
    expect(m.rpcCalls.map((c) => c.name)).not.toContain('owner_deactivate_staff')
    const confirmBtn = buttonsNamed('Continue').at(-1)!
    act(() => confirmBtn.click())
    await settle()
    expect(m.rpcCalls.find((c) => c.name === 'owner_deactivate_staff')?.args).toEqual({ p_user: 'cash-1' })
  })
})
