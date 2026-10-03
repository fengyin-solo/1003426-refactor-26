// 并发与联动验证：模拟两个操作方基于同一份旧数据同时发起领用与报废。
// node 里没有 window/localStorage，local-store 自动退化为内存存储，正好可测。
import { listUsableEquipment, runAction } from '@/api/local-service'
import { invalidateCache, listRows } from '@/data/local-store'

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

async function main() {
  invalidateCache()
  const before = listRows('equipment')
  check('种子装备 1 状态可用', before.find((r) => r.id === 1)?.status, '可用')
  check('初始可用器材数', listUsableEquipment().length, 1)

  // 两个操作方都基于 revision=1 的旧快照：一个要领用，一个要报废
  const checkout = runAction('equipment', 1, '领用装备', { expectedRevision: 1 })
  const scrap = runAction('equipment', 1, '报废装备', { expectedRevision: 1 })
  const [r1, r2] = await Promise.all([checkout, scrap])
  const results = [r1, r2]
  check('并发领用与报废只有一项落地', results.filter((r) => r.ok).length, 1)
  check('另一项收到冲突或状态提示', results.filter((r) => !r.ok).length, 1)
  const finalRow = listRows('equipment').find((r) => r.id === 1)
  check('落地后状态只有一种', ['已领用', '已报废'].includes(String(finalRow?.status)), true)
  check('落地后版本号递增', finalRow?.revision, 2)
  check('可用器材清单随之更新', listUsableEquipment().length, 0)

  // 已落地的装备不能重复流转：报废后不能再领用
  invalidateCache()
  const again = await runAction('equipment', 1, '领用装备', { expectedRevision: 2 })
  if (String(finalRow?.status) === '已报废') {
    check('已报废不能再领用', again.ok, false)
  } else {
    check('已领用不能重复领用', again.ok, false)
  }

  // 送检全流程：3 号装备 待检修 → 合格 → 可用，清单联动
  const pass = await runAction('equipment', 3, '送检合格', { expectedRevision: 1 })
  check('待检修可登记合格', pass.ok, true)
  check('合格后进入可用清单', listUsableEquipment().some((r) => r.id === 3), true)

  // 版本号不符的重复提交被拦截
  const stale = await runAction('equipment', 3, '送检登记', { expectedRevision: 1 })
  check('过期版本号的操作被拒绝', stale.ok, false)

  if (failures > 0) {
    console.error(`\n${failures} 项验证失败`)
    process.exit(1)
  }
  console.log('\n并发与联动验证全部通过')
}

main()
