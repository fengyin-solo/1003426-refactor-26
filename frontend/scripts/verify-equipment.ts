// 一次性验证脚本：验证装备状态机、存量回填迁移与并发互斥规则。
// 用 esbuild 打包后在 node 里跑，不进仓库源码。
import { migrateEnvelope } from '@/data/migrations'
import {
  applyEquipmentAction,
  backfillEquipmentRow,
  canApplyEquipmentAction,
  resolveEquipmentStatus,
  rowRevision,
} from '@/domain/equipment'
import type { EntryRow } from '@/data/types'

let failures = 0
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failures += 1
    console.error(`✗ ${name}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  } else {
    console.log(`✓ ${name}`)
  }
}

function row(partial: Partial<EntryRow> & { id: number; status: string }): EntryRow {
  return { pending: true, abnormal: false, ...partial } as EntryRow
}

// ---- 1. 存量回填：旧格式（无版本信封、装备行缺字段）迁移到 v2 ----
const legacy = {
  equipment: [
    // 缺 装备编号/规格型号/保管林场/revision/inspections 的旧行
    row({ id: 1, status: '已领用', 装备名称: '风力灭火机A', 装备类型: '风力灭火机' }),
    // 字段齐全的旧行：迁移必须原样保留（旧装备按原规则保留）
    row({
      id: 2,
      status: '已报废',
      装备编号: 'EQUI-0007',
      规格型号: '老式规格',
      保管林场: '东风林场',
    }),
    // 同样缺编号的第二行：编号要顺延不重复
    row({ id: 3, status: '可用', 装备类型: '消防水泵' }),
  ],
  patrol: [row({ id: 1, status: '待执行' })],
}
const migrated = migrateEnvelope(legacy)
check('迁移后版本号为 2', migrated.version, 2)
const [m1, m2, m3] = migrated.rows.equipment
check('缺编号行回填编号', m1['装备编号'], 'EQUI-0008') // 已有最大 EQUI-0007，顺延
check('缺规格行按类型回填', m1['规格型号'], 'EB-650')
check('缺林场行回填默认林场', m1['保管林场'], '局直属装备库')
check('回填行版本号', m1.revision, 1)
check('回填行送检记录', m1.inspections, [])
check('缺编号第二行顺延', m3['装备编号'], 'EQUI-0009')
check('齐全旧行编号保留', m2['装备编号'], 'EQUI-0007')
check('齐全旧行规格保留', m2['规格型号'], '老式规格')
check('齐全旧行状态保留', m2.status, '已报废')
check('旧行状态不被迁移改写', m1.status, '已领用')
check('其他模块原样带过', migrated.rows.patrol.length, 1)

// 未来版本不降级
const future = migrateEnvelope({ version: 99, rows: { equipment: [] } })
check('未来版本原样保留', future.version, 99)

// ---- 2. 冲突裁决：以最近送检结论为准 ----
check(
  '无送检记录旧装备按原规则保留',
  resolveEquipmentStatus(row({ id: 1, status: '已领用', inspections: [] })),
  '已领用',
)
check(
  '最近结论不合格 → 已报废（哪怕状态是已领用）',
  resolveEquipmentStatus(
    row({ id: 1, status: '已领用', inspections: [{ date: '2026-09-01', conclusion: '不合格' }] }),
  ),
  '已报废',
)
check(
  '最近结论合格 + 状态待检修 → 可用',
  resolveEquipmentStatus(
    row({ id: 1, status: '待检修', inspections: [{ date: '2026-09-01', conclusion: '合格' }] }),
  ),
  '可用',
)
check(
  '最近结论合格但之后又领用 → 已领用（结论不覆盖更新的流转）',
  resolveEquipmentStatus(
    row({ id: 1, status: '已领用', inspections: [{ date: '2026-09-01', conclusion: '合格' }] }),
  ),
  '已领用',
)
check(
  '多条记录取最近一条',
  resolveEquipmentStatus(
    row({
      id: 1,
      status: '待检修',
      inspections: [
        { date: '2026-08-01', conclusion: '不合格' },
        { date: '2026-09-01', conclusion: '合格' },
      ],
    }),
  ),
  '可用',
)

// ---- 3. 状态机流转校验 ----
const available = row({ id: 1, status: '可用', revision: 1, inspections: [] })
check('可用可领用', canApplyEquipmentAction(available, '领用装备'), true)
check('可用可送检', canApplyEquipmentAction(available, '送检登记'), true)
check('可用可报废', canApplyEquipmentAction(available, '报废装备'), true)
check('可用不能直接登记合格结论', canApplyEquipmentAction(available, '送检合格'), false)
const scrapped = row({ id: 1, status: '已报废', revision: 3, inspections: [] })
check('已报废是终态：不能领用', canApplyEquipmentAction(scrapped, '领用装备'), false)
check('已报废是终态：不能送检', canApplyEquipmentAction(scrapped, '送检登记'), false)
check('已报废是终态：不能重复报废', canApplyEquipmentAction(scrapped, '报废装备'), false)
const inspecting = row({ id: 1, status: '待检修', revision: 2, inspections: [] })
check('待检修可登记合格', canApplyEquipmentAction(inspecting, '送检合格'), true)
check('待检修可登记不合格', canApplyEquipmentAction(inspecting, '送检不合格'), true)
check('待检修不能领用', canApplyEquipmentAction(inspecting, '领用装备'), false)
// 裁决后状态参与校验：状态字段是已领用但最近结论不合格 → 视为已报废，不能领用
const conflicted = row({
  id: 1,
  status: '已领用',
  revision: 2,
  inspections: [{ date: '2026-09-01', conclusion: '不合格' }],
})
check('裁决为报废的装备不能领用', canApplyEquipmentAction(conflicted, '领用装备'), false)

// ---- 4. 动作应用：送检结论写记录、版本号递增 ----
const afterInspect = applyEquipmentAction(available, '送检登记')
check('送检登记后状态', afterInspect.status, '待检修')
check('送检登记版本号 +1', afterInspect.revision, 2)
const afterPass = applyEquipmentAction(afterInspect, '送检合格')
check('合格结论落库', afterPass.inspections, [{ date: new Date().toISOString().slice(0, 10), conclusion: '合格' }])
check('合格后状态', afterPass.status, '可用')
check('合格后最近检修日刷新', afterPass['最近检修日'], new Date().toISOString().slice(0, 10))
const afterFail = applyEquipmentAction(afterInspect, '送检不合格')
check('不合格结论后状态', afterFail.status, '已报废')

// ---- 5. 并发互斥的判定基础：版本号比对 ----
check('行版本号读取', rowRevision(row({ id: 1, status: '可用', revision: 5 })), 5)
check('无版本号旧行默认 1', rowRevision(row({ id: 1, status: '可用' })), 1)

// ---- 6. 回填幂等：迁移跑两遍结果一致 ----
const twice = migrateEnvelope(migrated)
check('迁移幂等', twice.rows.equipment, migrated.rows.equipment)

if (failures > 0) {
  console.error(`\n${failures} 项验证失败`)
  process.exit(1)
}
console.log('\n全部验证通过')
