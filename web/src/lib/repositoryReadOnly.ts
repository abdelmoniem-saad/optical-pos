// Read-only view of a repository (VITE_READ_ONLY=true - the owner's phone).
// Reads pass straight through; every write is refused before it reaches the
// network, because the shop PC is the system of record and the cloud is only
// its replica (a phone write would be overwritten by the next sync anyway).
import type { PosRepository } from './repository'
import { READ_ONLY_MESSAGE } from './config'

export const WRITE_METHODS = [
  'addCustomer',
  'updateCustomer',
  'deleteCustomer',
  'createSale',
  'updateSaleFull',
  'updateSale',
  'updateLabStatus',
  'setOrderImage',
  'addStandalonePrescription',
  'replaceOrderExaminations',
  'addProduct',
  'updateProduct',
  'adjustStock',
  'ensureFrameProduct',
  'addMetadata',
  'reorderMetadata',
  'deleteMetadata',
  'addMissingOrderMetadata',
  'syncExamReferences',
  'addNote',
  'updateNote',
  'deleteNote',
  'markNoteSeen',
  'toggleRoleGrant',
  'setUserOverride',
  'setSetting',
  'updateUserRole',
  'addRole',
  'addSupplier',
  'updateSupplier',
  'deleteSupplier',
  'addPurchase',
  'addPurchasePayment',
  'deletePurchasePayment',
] as const satisfies readonly (keyof PosRepository)[]

export class ReadOnlyError extends Error {
  constructor() {
    super(READ_ONLY_MESSAGE)
    this.name = 'ReadOnlyError'
  }
}

export function readOnly(inner: PosRepository): PosRepository {
  const blocked = new Set<string>(WRITE_METHODS)
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && blocked.has(prop)) {
        return () => Promise.reject(new ReadOnlyError())
      }
      const v = Reflect.get(target, prop, receiver)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}
