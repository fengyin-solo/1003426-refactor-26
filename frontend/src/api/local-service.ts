import {
  applyEquipmentTransition,
  findTransition,
  isEquipmentAvailable,
  resolveEquipmentStatus,
} from '@/data/equipment-rules'
import {
  acquireStorageLock,
  allRows,
  listRows,
  readRowsFresh,
  releaseStorageLock,
  resetRows,
  saveRows,
  subscribeEntries,
} from '@/data/local-store'
import { MODULE_BY_KEY } from '@/data/modules'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 状态裁决器：登记了裁决器的模块，对外输出一律用有效状态，各入口不再各算一套。
const STATUS_RESOLVERS: Record<string, (row: EntryRow) => string> = {
  equipment: resolveEquipmentStatus,
}

function effectiveRow(key: string, row: EntryRow): EntryRow {
  const resolve = STATUS_RESOLVERS[key]
  return resolve ? { ...row, status: resolve(row) } : row
}

function effectiveRows(key: string, rows: EntryRow[]): EntryRow[] {
  return STATUS_RESOLVERS[key] ? rows.map((row) => effectiveRow(key, row)) : rows
}

/** 时间戳：本地时间、秒级、可按字符串直接比较先后。 */
function nowStamp(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  )
}

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
  const matched = filterRows(effectiveRows(key, listRows(key)), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  if (key === 'equipment') {
    return runEquipmentAction(id, action)
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
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

/**
 * 装备动作的统一入口：领用、送检、报废都走 equipment-rules 的流转表。
 * 全程持模块写锁，锁内回源重读并按有效状态校验源状态——并发的领用与报废
 * 同时提交时，只有先到的一单能通过校验落地，另一单在写入前一刻被拦下。
 */
function runEquipmentAction(id: number, action: string): ActionResult {
  const transition = findTransition(action)
  if (!transition) {
    return { ok: false, message: `消防装备没有登记「${action}」这个动作` }
  }
  const token = acquireStorageLock('equipment')
  if (token === null) {
    return { ok: false, message: '另一笔装备操作正在提交，请稍后重试' }
  }
  try {
    const rows = readRowsFresh('equipment')
    const index = rows.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      return { ok: false, message: `没有找到编号为 ${id} 的消防装备` }
    }
    const current = resolveEquipmentStatus(rows[index])
    if (!transition.from.includes(current)) {
      return { ok: false, message: `消防装备当前状态「${current}」，不能执行「${action}」` }
    }
    const next = [...rows]
    next[index] = applyEquipmentTransition(rows[index], transition, nowStamp())
    saveRows('equipment', next)
    return { ok: true, message: `消防装备已${action}，当前状态「${transition.to}」` }
  } finally {
    releaseStorageLock('equipment', token)
  }
}

/** 扑火队伍模块的可用器材清单：按统一规则判定有效状态为「可用」的装备。 */
export function listAvailableEquipment(): EntryRow[] {
  return listRows('equipment').filter(isEquipmentAvailable).map((row) => effectiveRow('equipment', row))
}

/** 装备看板指标：与可用器材清单同源，都按有效状态统计。 */
export function summarizeEquipment(): Record<string, number> {
  const rows = effectiveRows('equipment', listRows('equipment'))
  return {
    '装备总数': rows.length,
    '可用装备': rows.filter((row) => row.status === '可用').length,
    '待检修数': rows.filter((row) => row.status === '待检修').length,
  }
}

/** 订阅数据变更：key 为模块名，跨页签广播时为 '*'。 */
export function onEntriesChanged(listener: (key: string) => void): () => void {
  return subscribeEntries(listener)
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of effectiveRows(key, listRows(key))) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
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
