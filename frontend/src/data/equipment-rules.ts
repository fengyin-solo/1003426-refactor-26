import type { EntryRow } from './types'

/**
 * 消防装备生命周期的唯一权威定义。
 *
 * 领用、送检、报废的规则以前散落在三处：modules.ts 的 actionTargets、
 * local-service 的通用流转、equipment 页面里硬编码的数组，历史数据迁移时
 * 各入口各算一套。现在统一收进这个模块：
 *   - modules.ts 的装备元数据从这里派生；
 *   - local-service 的装备动作只执行这里的流转表；
 *   - 扑火队伍模块的可用器材清单用这里的有效状态判定；
 *   - local-store 的历史数据迁移用这里的存量回填。
 * 页面组件不再保存任何一份规则副本。
 */

// ---- 状态机 ----------------------------------------------------------------

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

export const INSPECTION_OUTCOME = { pass: '合格', fail: '不合格' } as const

// 规则版本：迁移前已存在的存量装备打「旧规」，状态原样保留；规则生效后每落地一次流转改打「新规」。
export const RULE_VERSION = { legacy: '旧规', current: '新规' } as const

export type EquipmentTransition = {
  action: string
  /** 允许执行该动作的源状态集合；并发时靠它在写入前一刻重新校验，只有一单能落地 */
  from: string[]
  to: string
  /**
   * 流转落地时写入的送检结论：
   * 合格/不合格 = 本次送检（或报废鉴定）的结论；'清空' = 重新送检，旧结论作废；缺省 = 不动结论。
   */
  conclusion?: typeof INSPECTION_OUTCOME.pass | typeof INSPECTION_OUTCOME.fail | '清空'
}

/**
 * 装备流转表。领用与报废共用「可用」起点：两单并发提交时，先到的一单改变状态，
 * 后到的一单在写入前重新校验源状态必然失败，保证只有一项落地。
 * 已领用的装备不能直接报废，必须先送检（归还到库）再走报废鉴定。
 */
export const EQUIPMENT_TRANSITIONS: EquipmentTransition[] = [
  { action: '领用装备', from: [EQUIPMENT_STATUS.available], to: EQUIPMENT_STATUS.checkedOut },
  { action: '归还装备', from: [EQUIPMENT_STATUS.checkedOut], to: EQUIPMENT_STATUS.available },
  {
    action: '送检登记',
    from: [EQUIPMENT_STATUS.available, EQUIPMENT_STATUS.checkedOut],
    to: EQUIPMENT_STATUS.inspecting,
    conclusion: '清空',
  },
  {
    action: '送检合格',
    from: [EQUIPMENT_STATUS.inspecting],
    to: EQUIPMENT_STATUS.available,
    conclusion: INSPECTION_OUTCOME.pass,
  },
  {
    action: '报废装备',
    from: [EQUIPMENT_STATUS.available, EQUIPMENT_STATUS.inspecting],
    to: EQUIPMENT_STATUS.scrapped,
    conclusion: INSPECTION_OUTCOME.fail, // 报废视为最近一次鉴定不合格
  },
]

export const EQUIPMENT_ACTIONS: string[] = EQUIPMENT_TRANSITIONS.map((item) => item.action)

export const EQUIPMENT_ACTION_TARGETS: Record<string, string> = Object.fromEntries(
  EQUIPMENT_TRANSITIONS.map((item) => [item.action, item.to]),
)

export const EQUIPMENT_FIELDS: string[] = [
  '装备编号',
  '装备名称',
  '装备类型',
  '规格型号',
  '保管林场',
  '购入日期',
  '最近检修日',
  '送检结论',
  '送检日期',
  '规则版本',
]

export function findTransition(action: string): EquipmentTransition | undefined {
  return EQUIPMENT_TRANSITIONS.find((item) => item.action === action)
}

// ---- 有效状态裁决 -----------------------------------------------------------

/**
 * 装备的有效状态。登记状态（row.status）与最近一次送检结论冲突时，以最近送检结论为准；
 * 结论之后若又落地了更新的流转，则以新流转为准。没有送检结论的旧装备不做任何改写，
 * 按原规则保留登记状态。
 */
export function resolveEquipmentStatus(row: EntryRow): string {
  const stored = String(row.status ?? '')
  if (stored === EQUIPMENT_STATUS.scrapped) {
    return stored // 报废是终态，新旧规则一致
  }
  const outcome = String(row['送检结论'] ?? '').trim()
  const inspectedAt = String(row['送检日期'] ?? '').trim()
  if (!outcome || !inspectedAt) {
    return stored // 无送检结论（含全部存量旧装备）：按原规则保留
  }
  const changedAt = String(row['状态更新时间'] ?? '').trim()
  if (changedAt && changedAt >= inspectedAt) {
    return stored // 结论之后已有更新的流转落地
  }
  return outcome === INSPECTION_OUTCOME.pass
    ? EQUIPMENT_STATUS.available
    : EQUIPMENT_STATUS.scrapped
}

/** 当前可领用的装备：有效状态为「可用」，扑火队伍的可用器材清单也用它。 */
export function isEquipmentAvailable(row: EntryRow): boolean {
  return resolveEquipmentStatus(row) === EQUIPMENT_STATUS.available
}

/** 应用一次流转：状态、规则版本、状态更新时间、送检结论一次写齐。 */
export function applyEquipmentTransition(
  row: EntryRow,
  transition: EquipmentTransition,
  stamp: string,
): EntryRow {
  const next: EntryRow = {
    ...row,
    status: transition.to,
    pending: transition.to !== EQUIPMENT_STATUS.scrapped,
    '规则版本': RULE_VERSION.current,
    '状态更新时间': stamp,
  }
  if (transition.conclusion === '清空') {
    next['送检结论'] = ''
    next['送检日期'] = ''
  } else if (transition.conclusion) {
    next['送检结论'] = transition.conclusion
    next['送检日期'] = stamp
  }
  return next
}

// ---- 存量回填（历史数据迁移） -------------------------------------------------

// 示例数据里的占位写法，迁移时视同缺失。
const PLACEHOLDER_PATTERN = /^消防装备样例\d*$/

const SPEC_BY_TYPE: Record<string, string> = {
  灭火机具: 'FYJ-65 背负式',
  水泵装备: 'SB-170 高压接力',
  防护装具: 'FHZ-2 阻燃套装',
  通讯设备: 'TX-800 对讲终端',
  运输车辆: 'EQ-2045 四驱水罐',
}
const DEFAULT_SPEC = '通用型（待补录）'
const DEFAULT_FARM = '局属中心林场'

function needsBackfill(value: unknown): boolean {
  const text = String(value ?? '').trim()
  return text === '' || PLACEHOLDER_PATTERN.test(text)
}

/**
 * 回填单条存量装备：装备编号缺失或重复时按 id 生成并保证全表唯一；
 * 规格型号优先按装备类型推导，保管林场缺省归口局属中心林场。
 * 只补字段、不改状态，旧装备按原规则保留。幂等：重复执行结果一致。
 */
export function backfillEquipmentRow(
  row: EntryRow,
  index: number,
  usedCodes: Set<string>,
): EntryRow {
  const next: EntryRow = { ...row }
  let code = String(next['装备编号'] ?? '').trim()
  if (!code || PLACEHOLDER_PATTERN.test(code) || usedCodes.has(code)) {
    const base = `EQUI-${String(Number(next.id) || index + 1).padStart(4, '0')}`
    code = base
    let suffix = 1
    while (usedCodes.has(code)) {
      suffix += 1
      code = `${base}-${suffix}`
    }
  }
  usedCodes.add(code)
  next['装备编号'] = code
  if (needsBackfill(next['规格型号'])) {
    next['规格型号'] = SPEC_BY_TYPE[String(next['装备类型'] ?? '').trim()] ?? DEFAULT_SPEC
  }
  if (needsBackfill(next['保管林场'])) {
    next['保管林场'] = DEFAULT_FARM
  }
  if (String(next['规则版本'] ?? '').trim() === '') {
    next['规则版本'] = RULE_VERSION.legacy
  }
  // 老数据没有送检字段：补空位，裁决逻辑见到空结论会按原状态处理
  next['送检结论'] = String(next['送检结论'] ?? '')
  next['送检日期'] = String(next['送检日期'] ?? '')
  return next
}

export function backfillEquipmentRows(rows: EntryRow[]): EntryRow[] {
  const usedCodes = new Set<string>()
  return rows.map((row, index) => backfillEquipmentRow(row, index, usedCodes))
}
