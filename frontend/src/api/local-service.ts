import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, invalidateCache, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  applyEquipmentAction,
  canApplyEquipmentAction,
  EQUIPMENT_TRANSITIONS,
  resolveEquipmentStatus,
  rowRevision,
  type EquipmentAction,
} from '@/domain/equipment'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// pending / abnormal 的口径全模块共用这一套，装备专用路径也走这里，不另算。
function deriveFlags(meta: ModuleMeta, action: string, target: string): { pending: boolean; abnormal: boolean } {
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  return {
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)) || action === '送检不合格',
  }
}

export type ActionContext = {
  /** 页面读到的行版本号：与库内不一致说明有并发操作已落地，本次动作必须放弃。 */
  expectedRevision?: number
}

/**
 * 状态流转统一入口。装备模块走专用状态机（见 domain/equipment.ts），
 * 其余模块走通用映射；装备路径是异步的（并发锁），调用方一律 await。
 */
export function runAction(
  key: string,
  id: number,
  action: string,
  context: ActionContext = {},
): ActionResult | Promise<ActionResult> {
  if (key === 'equipment') {
    return runEquipmentAction(id, action, context)
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    ...deriveFlags(meta, action, target),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

/** 跨标签页互斥：同一时刻只允许一个装备流转进入读-改-写临界区。 */
function withEquipmentLock<T>(task: () => T): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (locks) {
    return locks.request('forest-fire-patrol:equipment', () => task())
  }
  return Promise.resolve().then(task)
}

/**
 * 装备专用流转：先重读本地数据，再按状态机校验，最后乐观锁落库。
 * 并发的领用与报废只有一个能通过版本校验，另一个收到冲突提示。
 */
async function runEquipmentAction(id: number, action: string, context: ActionContext): Promise<ActionResult> {
  return withEquipmentLock((): ActionResult => {
    const meta = moduleMeta('equipment')
    const rule = EQUIPMENT_TRANSITIONS[action as EquipmentAction]
    if (!rule) {
      return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
    }
    invalidateCache()
    const rows = listRows('equipment')
    const index = rows.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
    }
    const row = rows[index]
    const current = resolveEquipmentStatus(row)
    if (!canApplyEquipmentAction(row, action)) {
      return { ok: false, message: `${meta.entity}当前状态「${current}」，不能执行「${action}」` }
    }
    if (context.expectedRevision !== undefined && rowRevision(row) !== context.expectedRevision) {
      return { ok: false, message: '该装备刚被另一笔操作更新（可能已被领用或报废），请刷新后重试' }
    }
    const updated: EntryRow = {
      ...applyEquipmentAction(row, action as EquipmentAction),
      ...deriveFlags(meta, action, rule.to),
    }
    const next = [...rows]
    next[index] = updated
    saveRows('equipment', next)
    return { ok: true, message: `${meta.entity}已${action}，当前状态「${rule.to}」` }
  })
}

/**
 * 可用器材清单：状态裁决后为「可用」的装备。
 * 扑火队伍模块按保管林场匹配所属林场来取，装备侧任何流转落地后这里随之变化。
 */
export function listUsableEquipment(): EntryRow[] {
  invalidateCache()
  return listRows('equipment').filter(
    (row) => resolveEquipmentStatus(row) === '可用',
  )
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    // 装备的状态口径与页面一致：导出也按最近送检结论裁决后的状态
    const status = key === 'equipment' ? resolveEquipmentStatus(row) : String(row.status)
    lines.push([row.id, ...meta.fields.map((field) => String(row[field] ?? '')), status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
