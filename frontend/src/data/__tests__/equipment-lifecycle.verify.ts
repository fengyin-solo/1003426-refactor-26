/**
 * 消防装备统一规则的端到端验证：版本兼容迁移、存量回填、送检结论冲突裁决、
 * 并发领用/报废互斥、扑火队伍可用器材清单联动。
 * 运行：npm run verify（esbuild 打包后用 node 执行，不依赖浏览器）。
 */
import assert from 'node:assert/strict'

import {
  backfillEquipmentRows,
  resolveEquipmentStatus,
} from '@/data/equipment-rules'
import { invalidateCache, listRows, storageKey } from '@/data/local-store'
import {
  listAvailableEquipment,
  listEntries,
  runAction,
  summarizeEquipment,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

// ---- 浏览器环境 shim：local-store 在调用时才碰 window，导入后再补即可 ----------

function createMemoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => void map.set(key, String(value)),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  }
}

const memoryStorage = createMemoryStorage()
;(globalThis as Record<string, unknown>).window = { localStorage: memoryStorage }

function resetStorage(payload?: unknown) {
  memoryStorage.clear()
  if (payload !== undefined) {
    memoryStorage.setItem(storageKey(), JSON.stringify(payload))
  }
  invalidateCache()
}

function equipmentRow(id: number): EntryRow {
  const row = listRows('equipment').find((item) => Number(item.id) === id)
  assert.ok(row, `装备 ${id} 应存在`)
  return row!
}

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

// ---- 1. v1 旧数据版本兼容 + 存量回填 ---------------------------------------------

check('v1 平铺数据迁移到 v2：装备编号/规格型号/保管林场回填，状态原样保留', () => {
  resetStorage({
    equipment: [
      {
        id: 7,
        status: '已领用',
        pending: true,
        abnormal: false,
        '装备编号': '',
        '装备名称': '风力灭火机',
        '装备类型': '灭火机具',
        '规格型号': '消防装备样例7', // 占位值视同缺失
        '保管林场': '消防装备样例7',
      },
    ],
  })
  const row = equipmentRow(7)
  assert.equal(row['装备编号'], 'EQUI-0007')
  assert.equal(row['规格型号'], 'FYJ-65 背负式')
  assert.equal(row['保管林场'], '局属中心林场')
  assert.equal(row['规则版本'], '旧规') // 存量装备打旧规标记
  assert.equal(row.status, '已领用') // 旧装备按原规则保留，状态不被改写
  const persisted = JSON.parse(memoryStorage.getItem(storageKey())!) as {
    version: number
    modules: Record<string, EntryRow[]>
  }
  assert.equal(persisted.version, 2)
  assert.ok(Array.isArray(persisted.modules['patrol'])) // 缺省模块从种子合并进来
})

check('迁移幂等：重复读取结果一致，不会二次回填', () => {
  invalidateCache()
  const again = equipmentRow(7)
  assert.equal(again['装备编号'], 'EQUI-0007')
  assert.equal(again['规则版本'], '旧规')
})

check('装备编号重复时按 id 重新生成并保证全表唯一', () => {
  const rows = backfillEquipmentRows([
    { id: 1, status: '可用', pending: true, abnormal: false, '装备编号': 'EQUI-0001' },
    { id: 2, status: '可用', pending: true, abnormal: false, '装备编号': 'EQUI-0001' },
  ])
  assert.equal(rows[0]['装备编号'], 'EQUI-0001')
  assert.equal(rows[1]['装备编号'], 'EQUI-0002')
})

// ---- 2. 冲突时以最近送检结论为准 ---------------------------------------------------

check('送检结论比登记状态新：以最近送检结论为准', () => {
  const base = { id: 1, pending: true, abnormal: false }
  assert.equal(
    resolveEquipmentStatus({
      ...base,
      status: '已领用',
      '送检结论': '不合格',
      '送检日期': '2026-09-20 10:00:00',
      '状态更新时间': '2026-09-01 09:00:00',
    }),
    '已报废',
  )
  assert.equal(
    resolveEquipmentStatus({
      ...base,
      status: '待检修',
      '送检结论': '合格',
      '送检日期': '2026-09-20 10:00:00',
      '状态更新时间': '2026-09-19 09:00:00',
    }),
    '可用',
  )
})

check('结论之后又有更新的流转：以新流转为准', () => {
  assert.equal(
    resolveEquipmentStatus({
      id: 1,
      pending: true,
      abnormal: false,
      status: '已领用',
      '送检结论': '合格',
      '送检日期': '2026-09-20 10:00:00',
      '状态更新时间': '2026-09-21 09:00:00',
    }),
    '已领用',
  )
})

check('旧装备没有送检结论：按原规则保留登记状态；报废恒为终态', () => {
  assert.equal(resolveEquipmentStatus({ id: 1, status: '已领用', pending: true, abnormal: false }), '已领用')
  assert.equal(
    resolveEquipmentStatus({
      id: 1,
      status: '已报废',
      pending: false,
      abnormal: false,
      '送检结论': '合格',
      '送检日期': '2026-09-20 10:00:00',
    }),
    '已报废',
  )
})

// ---- 3. 统一流转：前置校验 + 并发互斥 -------------------------------------------------

check('完整生命周期：领用→归还→送检→合格→再送检→报废', () => {
  resetStorage()
  assert.equal(runAction('equipment', 1, '领用装备').ok, true)
  assert.equal(equipmentRow(1).status, '已领用')
  assert.equal(equipmentRow(1)['规则版本'], '新规') // 流转落地后改打新规
  assert.equal(runAction('equipment', 1, '归还装备').ok, true)
  assert.equal(runAction('equipment', 1, '送检登记').ok, true)
  assert.equal(equipmentRow(1).status, '待检修')
  assert.equal(runAction('equipment', 1, '送检合格').ok, true)
  assert.equal(equipmentRow(1)['送检结论'], '合格')
  assert.equal(runAction('equipment', 1, '送检登记').ok, true)
  assert.equal(equipmentRow(1)['送检结论'], '') // 重新送检，旧结论作废
  assert.equal(runAction('equipment', 1, '报废装备').ok, true)
  assert.equal(equipmentRow(1).status, '已报废')
  assert.equal(equipmentRow(1)['送检结论'], '不合格') // 报废视为鉴定不合格
})

check('非法流转被拦下：已领用不能直接报废，已报废不能再领用', () => {
  resetStorage()
  const blocked = runAction('equipment', 2, '报废装备') // id2 是已领用
  assert.equal(blocked.ok, false)
  assert.match(blocked.message, /不能执行/)
  resetStorage()
  runAction('equipment', 1, '报废装备')
  assert.equal(runAction('equipment', 1, '领用装备').ok, false)
})

check('并发领用与报废只允许一项落地', () => {
  resetStorage()
  const first = runAction('equipment', 1, '领用装备')
  const second = runAction('equipment', 1, '报废装备') // 同一装备的并发报废
  assert.equal(first.ok, true)
  assert.equal(second.ok, false) // 后到的一单被源状态校验拦下
  assert.equal(equipmentRow(1).status, '已领用')
  resetStorage()
  assert.equal(runAction('equipment', 1, '报废装备').ok, true)
  assert.equal(runAction('equipment', 1, '领用装备').ok, false)
  assert.equal(equipmentRow(1).status, '已报废')
})

check('另一页签已改状态时，本页签的并发操作按最新状态判定', () => {
  resetStorage()
  listRows('equipment') // 触发种子落盘，拿到可改写的 v2 信封
  // 模拟另一页签直接把装备报废（绕过本页签缓存）
  const persisted = JSON.parse(memoryStorage.getItem(storageKey())!) as {
    version: number
    modules: Record<string, EntryRow[]>
  }
  persisted.modules['equipment'] = persisted.modules['equipment'].map((row) =>
    Number(row.id) === 1 ? { ...row, status: '已报废' } : row,
  )
  memoryStorage.setItem(storageKey(), JSON.stringify(persisted))
  // 本页签缓存还是「可用」，但写入前回源重读，领用必须失败
  const result = runAction('equipment', 1, '领用装备')
  assert.equal(result.ok, false)
  assert.equal(equipmentRow(1).status, '已报废')
})

// ---- 4. 扑火队伍可用器材清单联动 -----------------------------------------------------

check('可用器材清单跟随装备规则实时更新', () => {
  resetStorage()
  const before = listAvailableEquipment().map((row) => Number(row.id))
  assert.deepEqual(before, [1]) // 初始只有 id1 可用（id2 已领用、id3 待检修）
  runAction('equipment', 2, '归还装备')
  const after = listAvailableEquipment().map((row) => Number(row.id))
  assert.deepEqual(after, [1, 2])
  runAction('equipment', 1, '报废装备')
  assert.deepEqual(listAvailableEquipment().map((row) => Number(row.id)), [2])
  const summary = summarizeEquipment()
  assert.equal(summary['可用装备'], 1)
  assert.equal(summary['装备总数'], 3)
})

check('清单与列表都按有效状态输出：登记已领用但最新结论不合格，按已报废处理', () => {
  resetStorage()
  listRows('equipment') // 触发种子落盘，拿到可改写的 v2 信封
  const persisted = JSON.parse(memoryStorage.getItem(storageKey())!) as {
    version: number
    modules: Record<string, EntryRow[]>
  }
  persisted.modules['equipment'] = persisted.modules['equipment'].map((row) =>
    Number(row.id) === 2
      ? {
          ...row,
          status: '已领用',
          '送检结论': '不合格',
          '送检日期': '2026-09-30 08:00:00',
          '状态更新时间': '2026-09-01 08:00:00',
        }
      : row,
  )
  memoryStorage.setItem(storageKey(), JSON.stringify(persisted))
  invalidateCache()
  const listed = listEntries('equipment').items.find((row) => Number(row.id) === 2)
  assert.equal(listed?.status, '已报废') // 冲突时以最近送检结论为准
  assert.deepEqual(listAvailableEquipment().map((row) => Number(row.id)), [1])
  assert.equal(runAction('equipment', 2, '归还装备').ok, false) // 有效状态不是已领用
})

// ---- 5. 其他模块不受影响 --------------------------------------------------------------

check('通用模块仍走原流转逻辑', () => {
  resetStorage()
  const result = runAction('patrol', 1, '开始巡护')
  assert.equal(result.ok, true)
  assert.equal(listRows('patrol')[0].status, '执行中')
})

console.log(`\n${passed} 项验证全部通过`)
