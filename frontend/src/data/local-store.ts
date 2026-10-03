import { migrateEnvelope, STORAGE_VERSION } from './migrations'
import { SEED_ROWS } from './seed'
import type { EntryRow, StorageEnvelope } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// 存储值是带版本号的信封 { version, rows }，旧格式读取时自动迁移（见 migrations.ts）。
const STORAGE_KEY = 'forest-fire-patrol:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function seedEnvelope(): StorageEnvelope {
  // 种子数据本身已是当前版本结构，迁移一遍只是为了幂等兜底
  return migrateEnvelope(clone(SEED_ROWS))
}

// 无 localStorage 的环境（测试、SSR）用模块级内存兜底，读写语义与浏览器一致
let memoryFallback: StorageEnvelope | null = null

function readStorage(): StorageEnvelope {
  const fallback = seedEnvelope()
  if (typeof window === 'undefined' || !window.localStorage) {
    if (memoryFallback === null) {
      memoryFallback = fallback
    }
    return memoryFallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const envelope = migrateEnvelope(JSON.parse(raw))
    return { version: envelope.version, rows: { ...fallback.rows, ...envelope.rows } }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: StorageEnvelope | null = null

function envelope(): StorageEnvelope {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function allRows(): Record<string, EntryRow[]> {
  return envelope().rows
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const current = envelope()
  const next: StorageEnvelope = { version: current.version, rows: { ...current.rows, [key]: rows } }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } else {
    memoryFallback = next
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

/**
 * 丢弃内存缓存，下次读取强制回到 localStorage。
 * 装备状态流转前必须调一次：另一个标签页（或另一次并发操作）的写入
 * 只有重新读过才能看见，乐观锁才有效。
 */
export function invalidateCache(): void {
  cache = null
}

export function storageKey(): string {
  return STORAGE_KEY
}

export function storageVersion(): number {
  return STORAGE_VERSION
}
