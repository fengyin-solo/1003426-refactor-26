import { backfillEquipmentRow } from '@/domain/equipment'
import type { EntryRow, StorageEnvelope } from './types'

/**
 * 持久化版本兼容：localStorage 里的数据带版本号，读取时逐级迁移到当前版本。
 *
 * - v1：初版格式，整个值直接就是 { 模块: 行[] }，装备行可能缺
 *   装备编号 / 规格型号 / 保管林场，也没有行版本号和送检记录；
 * - v2：信封格式 { version, rows }，装备行完成存量回填。
 *
 * 比当前版本新的数据（未来版本）不迁移、不降级，原样保留，避免旧代码写坏新数据。
 */
export const STORAGE_VERSION = 2

function isEnvelope(value: unknown): value is StorageEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as StorageEnvelope).version === 'number' &&
    typeof (value as StorageEnvelope).rows === 'object' &&
    (value as StorageEnvelope).rows !== null
  )
}

/** v1 → v2：对装备模块做存量回填，其余模块原样带过。 */
function migrateV1toV2(rows: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const equipment = Array.isArray(rows.equipment) ? rows.equipment : []
  // 先全量收集已有编号再逐行回填：缺编号的行必须避开所有已占用编号，
  // 否则前面补发的编号可能和后面行的旧编号撞号
  const usedCodes = new Set<string>(
    equipment
      .map((row) => row['装备编号'])
      .filter((code): code is string => typeof code === 'string' && code.trim() !== ''),
  )
  return {
    ...rows,
    equipment: equipment.map((row) => backfillEquipmentRow(row, usedCodes)),
  }
}

/**
 * 把读到的任意历史格式归一成当前版本的信封。
 * 返回的 version 可能高于 STORAGE_VERSION（未来数据），调用方写回时必须保留原版本号。
 */
export function migrateEnvelope(parsed: unknown): StorageEnvelope {
  if (!isEnvelope(parsed)) {
    // 初版格式：整个对象就是 rows
    const rows = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, EntryRow[]>
    return { version: STORAGE_VERSION, rows: migrateV1toV2(rows) }
  }
  if (parsed.version < STORAGE_VERSION) {
    return { version: STORAGE_VERSION, rows: migrateV1toV2(parsed.rows) }
  }
  if (parsed.version > STORAGE_VERSION) {
    console.warn(`本地数据版本 ${parsed.version} 高于当前支持的 ${STORAGE_VERSION}，按只读兼容处理`)
  }
  return parsed
}
