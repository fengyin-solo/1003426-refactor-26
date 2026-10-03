import type { EntryRow, InspectionRecord } from '@/data/types'

/**
 * 消防装备状态规则的唯一事实来源。
 *
 * 领用、送检、报废以前散落在 modules.ts 的动作映射、页面硬编码和通用流转里，
 * 历史数据迁移时各入口各算一套。现在所有「装备当前算什么状态、能做什么动作」
 * 的判断都收在这个文件：页面、模块元数据、本地服务一律从这里取，不再各自解释。
 */

export const EQUIPMENT_STATUS = {
  available: '可用',
  checkedOut: '已领用',
  inspecting: '待检修',
  scrapped: '已报废',
} as const

export const EQUIPMENT_STATUSES: string[] = [
  EQUIPMENT_STATUS.available,
  EQUIPMENT_STATUS.checkedOut,
  EQUIPMENT_STATUS.inspecting,
  EQUIPMENT_STATUS.scrapped,
]

export type EquipmentAction = '领用装备' | '送检登记' | '送检合格' | '送检不合格' | '报废装备'

/**
 * 流转表：动作 → 允许的源状态 + 目标状态。
 * 已报废是终态；送检结论（合格/不合格）只能从待检修进入，保证「结论」一定
 * 对应一次真实送检，而不是凭空改状态。
 */
export const EQUIPMENT_TRANSITIONS: Record<EquipmentAction, { from: string[]; to: string }> = {
  领用装备: { from: [EQUIPMENT_STATUS.available], to: EQUIPMENT_STATUS.checkedOut },
  送检登记: { from: [EQUIPMENT_STATUS.available, EQUIPMENT_STATUS.checkedOut], to: EQUIPMENT_STATUS.inspecting },
  送检合格: { from: [EQUIPMENT_STATUS.inspecting], to: EQUIPMENT_STATUS.available },
  送检不合格: { from: [EQUIPMENT_STATUS.inspecting], to: EQUIPMENT_STATUS.scrapped },
  报废装备: {
    from: [EQUIPMENT_STATUS.available, EQUIPMENT_STATUS.checkedOut, EQUIPMENT_STATUS.inspecting],
    to: EQUIPMENT_STATUS.scrapped,
  },
}

export const EQUIPMENT_ACTIONS: string[] = Object.keys(EQUIPMENT_TRANSITIONS)

/** modules.ts 的 actionTargets 是这个表的投影，目标状态只在这里维护一份。 */
export const EQUIPMENT_ACTION_TARGETS: Record<string, string> = Object.fromEntries(
  Object.entries(EQUIPMENT_TRANSITIONS).map(([action, rule]) => [action, rule.to]),
)

/** 存量回填用的默认值：装备类型 → 规格型号。查不到的一律按通用规格登记，留待补录。 */
const DEFAULT_SPEC_BY_TYPE: Record<string, string> = {
  风力灭火机: 'EB-650',
  消防水泵: 'SP-200',
  灭火水枪: 'SQ-40',
  油锯: 'YJ-58',
  防火服: 'FHF-Ⅱ',
  对讲机: 'DJ-350',
}

export const DEFAULT_STORAGE_FARM = '局直属装备库'
export const DEFAULT_SPEC_FALLBACK = '通用规格'

function isPresent(value: unknown): boolean {
  return typeof value === 'string' ? value.trim() !== '' : value !== undefined && value !== null
}

export function getInspections(row: EntryRow): InspectionRecord[] {
  return Array.isArray(row.inspections) ? row.inspections : []
}

export function latestInspection(row: EntryRow): InspectionRecord | null {
  const records = getInspections(row)
  return records.length > 0 ? records[records.length - 1] : null
}

export function rowRevision(row: EntryRow): number {
  return typeof row.revision === 'number' ? row.revision : 1
}

/**
 * 冲突裁决：状态字段与送检记录不一致时，以最近送检结论为准。
 * - 最近结论「不合格」→ 一律按已报废论，哪怕状态字段还停在已领用；
 * - 最近结论「合格」而状态还挂在待检修 → 按可用论；
 * - 没有任何送检记录的旧装备 → 原样返回，仍按原规则保留，迁移不改写它的状态。
 */
export function resolveEquipmentStatus(row: EntryRow): string {
  const latest = latestInspection(row)
  if (!latest) {
    return String(row.status)
  }
  if (latest.conclusion === '不合格') {
    return EQUIPMENT_STATUS.scrapped
  }
  if (String(row.status) === EQUIPMENT_STATUS.inspecting) {
    return EQUIPMENT_STATUS.available
  }
  return String(row.status)
}

export function canApplyEquipmentAction(row: EntryRow, action: string): boolean {
  const rule = EQUIPMENT_TRANSITIONS[action as EquipmentAction]
  if (!rule) {
    return false
  }
  return rule.from.includes(resolveEquipmentStatus(row))
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * 应用一次动作，返回新行（纯函数，不写库）。
 * 送检结论会追加进 inspections 并刷新最近检修日；行版本号每次 +1 供并发校验。
 */
export function applyEquipmentAction(row: EntryRow, action: EquipmentAction): EntryRow {
  const rule = EQUIPMENT_TRANSITIONS[action]
  const next: EntryRow = {
    ...row,
    status: rule.to,
    revision: rowRevision(row) + 1,
    inspections: getInspections(row),
  }
  if (action === '送检合格' || action === '送检不合格') {
    const conclusion = action === '送检合格' ? '合格' : '不合格'
    next.inspections = [...getInspections(row), { date: today(), conclusion }]
    next['最近检修日'] = today()
  }
  return next
}

/**
 * 存量回填（v1 → v2）：只补齐缺失字段，不动已有值、不动状态。
 * 旧装备即使字段残缺，也按原规则保留原状，由使用人后续补录。
 *
 * usedCodes 是本次迁移内已占用的装备编号集合，调用方在多行之间共享，
 * 保证批量回填时编号不重复。
 */
export function backfillEquipmentRow(row: EntryRow, usedCodes: Set<string>): EntryRow {
  const next: EntryRow = { ...row }
  if (!isPresent(next['装备编号'])) {
    next['装备编号'] = allocateEquipmentCode(usedCodes)
  } else {
    usedCodes.add(String(next['装备编号']))
  }
  if (!isPresent(next['规格型号'])) {
    next['规格型号'] = DEFAULT_SPEC_BY_TYPE[String(next['装备类型'] ?? '')] ?? DEFAULT_SPEC_FALLBACK
  }
  if (!isPresent(next['保管林场'])) {
    next['保管林场'] = DEFAULT_STORAGE_FARM
  }
  if (typeof next.revision !== 'number') {
    next.revision = 1
  }
  if (!Array.isArray(next.inspections)) {
    next.inspections = []
  }
  return next
}

/** 从已占用的编号里找最大序号，顺延生成 EQUI-XXXX；没有历史编号时从 1 开始。 */
function allocateEquipmentCode(usedCodes: Set<string>): string {
  let max = 0
  for (const code of usedCodes) {
    const match = /^EQUI-(\d+)$/.exec(code)
    if (match) {
      max = Math.max(max, Number(match[1]))
    }
  }
  let candidate = ''
  do {
    max += 1
    candidate = `EQUI-${String(max).padStart(4, '0')}`
  } while (usedCodes.has(candidate))
  usedCodes.add(candidate)
  return candidate
}
