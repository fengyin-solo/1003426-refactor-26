<template>
  <section class="page" data-module="equipment">
    <header class="page-head">
      <div>
        <h2>消防装备管理</h2>
        <p class="page-desc">维护消防装备，围绕装备编号、装备名称、装备类型、规格型号做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记消防装备</button>
        <button class="btn" type="button" @click="exportRows">导出消防装备清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>最近送检</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ resolvedStatus(row) }}</td>
          <td>{{ latestInspectionLabel(row) }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              :disabled="!canRun(row, action)"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无消防装备数据，可先登记消防装备</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条消防装备记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  canApplyEquipmentAction,
  EQUIPMENT_ACTIONS,
  EQUIPMENT_STATUSES,
  latestInspection,
  resolveEquipmentStatus,
  rowRevision,
} from '@/domain/equipment'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('equipment')
const columns = ["装备编号", "装备名称", "装备类型", "规格型号", "保管林场", "购入日期", "最近检修日", "装备状态"]
// 动作与状态口径全部来自领域状态机，页面不再自己维护一份
const actions = EQUIPMENT_ACTIONS
const statuses = EQUIPMENT_STATUSES
const stats = [{"label": "装备总数", "value": 0}, {"label": "可用装备", "value": 0}, {"label": "待检修数", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => resolveEquipmentStatus(row) === status).length,
  })),
)

function resolvedStatus(row: EntryRow): string {
  return resolveEquipmentStatus(row)
}

function latestInspectionLabel(row: EntryRow): string {
  const latest = latestInspection(row)
  return latest ? `${latest.date} ${latest.conclusion}` : '—'
}

function canRun(row: EntryRow, action: string): boolean {
  return canApplyEquipmentAction(row, action)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '消防装备登记入口尚未接入审批流'
}

async function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  // 带上读取时的行版本号：并发领用/报废只有一笔能落地，另一笔在这里收到冲突提示
  const result = await applyAction(meta.key, Number(row.id), action, {
    expectedRevision: rowRevision(row),
  })
  if (!result.ok) {
    // 先刷新到最新状态再亮出提示，否则 reload 会把错误消息清掉
    reload()
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '消防装备列表读取失败'
  }
}

onMounted(reload)
</script>
