import { backfillEquipmentRows } from './equipment-rules'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'

// 存储结构版本：v1 是「模块名 -> 行数组」的平铺对象；v2 起外面包一层 { version, modules }，
// 装备模块在 v2 补齐装备编号/规格型号/保管林场并打上规则版本标记。
export const STORAGE_VERSION = 2

type StorageEnvelope = {
  version: number
  modules: Record<string, EntryRow[]>
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function seedModules(): Record<string, EntryRow[]> {
  return clone(SEED_ROWS)
}

/**
 * 把任意历史 payload 统一成最新结构：v1 平铺格式先包壳，再逐版本迁移。
 * 种子里的新模块会合并进来，老浏览器存的数据缺新模块时也能打开。
 * 迁移幂等，重复执行结果一致。
 */
function migrateEnvelope(raw: unknown): { envelope: StorageEnvelope; changed: boolean } {
  let envelope: StorageEnvelope
  let changed = false
  const candidate = raw as Partial<StorageEnvelope> | null
  if (
    candidate &&
    typeof candidate === 'object' &&
    typeof candidate.version === 'number' &&
    candidate.modules &&
    typeof candidate.modules === 'object'
  ) {
    envelope = { version: candidate.version, modules: candidate.modules }
  } else if (candidate && typeof candidate === 'object') {
    envelope = { version: 1, modules: candidate as Record<string, EntryRow[]> } // v1 平铺格式
    changed = true
  } else {
    envelope = { version: 0, modules: {} }
    changed = true
  }
  envelope.modules = { ...seedModules(), ...envelope.modules }
  if (envelope.version < 2) {
    // v1 -> v2：装备存量回填（装备编号/规格型号/保管林场），状态保持原样
    envelope = {
      ...envelope,
      version: 2,
      modules: {
        ...envelope.modules,
        equipment: backfillEquipmentRows(envelope.modules['equipment'] ?? []),
      },
    }
    changed = true
  }
  if (envelope.version !== STORAGE_VERSION) {
    envelope = { ...envelope, version: STORAGE_VERSION }
    changed = true
  }
  return { envelope, changed }
}

function persist(envelope: StorageEnvelope): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope))
  }
}

function readStorage(): Record<string, EntryRow[]> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return migrateEnvelope(null).envelope.modules
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const { envelope } = migrateEnvelope(null)
    persist(envelope)
    return envelope.modules
  }
  try {
    const { envelope, changed } = migrateEnvelope(JSON.parse(raw))
    if (changed) {
      persist(envelope) // 迁移结果立即落盘，只迁一次
    }
    return envelope.modules
  } catch {
    const { envelope } = migrateEnvelope(null)
    persist(envelope)
    return envelope.modules
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

/** 强制回源重读：别的页签刚写入时，缓存可能是旧的，并发判定必须看最新值。 */
export function readRowsFresh(key: string): EntryRow[] {
  cache = readStorage()
  return cache[key] ?? []
}

export function invalidateCache(): void {
  cache = null
}

// ---- 变更订阅：装备规则生效后，扑火队伍等模块跟着刷新 -----------------------------

type EntriesListener = (key: string) => void
const listeners = new Set<EntriesListener>()

export function subscribeEntries(listener: EntriesListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function notify(key: string): void {
  for (const listener of listeners) {
    listener(key)
  }
}

if (typeof window !== 'undefined') {
  // 跨页签同步：另一个标签页写入后，本页签丢缓存并广播
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) {
      invalidateCache()
      notify('*')
    }
  })
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  persist({ version: STORAGE_VERSION, modules: next })
  notify(key)
}

export function resetRows(key: string): EntryRow[] {
  const seeded = clone(SEED_ROWS[key] ?? [])
  // 重置也走存量回填，保证装备字段和规则版本标记不缺口
  const rows = key === 'equipment' ? backfillEquipmentRows(seeded) : seeded
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

// ---- 模块级写锁：并发的领用与报废只允许一项落地 -----------------------------------

const LOCK_PREFIX = 'forest-fire-patrol:lock:'
const LOCK_TTL_MS = 3000

function lockKey(name: string): string {
  return `${LOCK_PREFIX}${name}`
}

/**
 * 抢锁：localStorage 的读写各自原子，但「读-判-写」不是，所以写入后再回读一次
 * 确认 token 还是自己的；两个页签同时抢时，只有回读一致的一方算拿到锁。
 * 无 localStorage 的环境（测试、SSR）单线程执行，直接放行。
 */
export function acquireStorageLock(name: string): string | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return 'no-storage'
  }
  const key = lockKey(name)
  const now = Date.now()
  const raw = window.localStorage.getItem(key)
  if (raw) {
    try {
      const held = JSON.parse(raw) as { expiresAt?: number }
      if (typeof held.expiresAt === 'number' && held.expiresAt > now) {
        return null // 锁被别的操作持有
      }
    } catch {
      // 坏锁按可抢占处理
    }
  }
  const token = `${now}:${Math.random().toString(36).slice(2)}`
  window.localStorage.setItem(key, JSON.stringify({ token, expiresAt: now + LOCK_TTL_MS }))
  const confirmRaw = window.localStorage.getItem(key)
  if (!confirmRaw || !confirmRaw.includes(token)) {
    return null // 同时抢锁，回读到的不是自己，算输
  }
  return token
}

export function releaseStorageLock(name: string, token: string): void {
  if (typeof window === 'undefined' || !window.localStorage || token === 'no-storage') {
    return
  }
  const key = lockKey(name)
  const raw = window.localStorage.getItem(key)
  if (raw && raw.includes(token)) {
    window.localStorage.removeItem(key)
  }
}
