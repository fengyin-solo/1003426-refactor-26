/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

/** 送检结论记录：目前只有消防装备模块在用，挂在行内随记录一起持久化。 */
export type InspectionRecord = {
  date: string
  conclusion: '合格' | '不合格'
}

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  /** 行版本号：每次状态流转 +1，并发领用/报废时用它做乐观锁。 */
  revision?: number
  /** 送检记录，时间顺序追加，最后一条即「最近送检结论」。 */
  inspections?: InspectionRecord[]
  [field: string]: string | number | boolean | InspectionRecord[] | undefined
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** localStorage 里的持久化信封：带版本号，旧格式数据读取时逐级迁移。 */
export type StorageEnvelope = {
  version: number
  rows: Record<string, EntryRow[]>
}
