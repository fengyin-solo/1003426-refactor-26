<template>
  <section class="page" data-module="fireteam">
    <header class="page-head">
      <div>
        <h2>扑火队伍管理</h2>
        <p class="page-desc">维护扑火队伍，围绕队伍编号、队伍名称、所属林场、队长姓名做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记扑火队伍</button>
        <button class="btn" type="button" @click="exportRows">导出扑火队伍清单</button>
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
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无扑火队伍数据，可先登记扑火队伍</td>
        </tr>
      </tbody>
    </table>

    <section class="gear-panel">
      <h3 class="gear-title">各队可用器材清单</h3>
      <p class="gear-desc">按所属林场匹配消防装备的保管林场，只列状态裁决为「可用」的器材；装备侧领用、送检、报废落地后这里同步更新。</p>
      <div class="gear-grid">
        <article v-for="team in rows" :key="`gear-${String(team.id)}`" class="gear-card">
          <header class="gear-card-head">
            <strong>{{ team['队伍名称'] }}</strong>
            <span class="gear-farm">{{ team['所属林场'] }}</span>
          </header>
          <ul v-if="usableGearFor(team).length" class="gear-list">
            <li v-for="gear in usableGearFor(team)" :key="String(gear.id)">
              <span class="gear-code">{{ gear['装备编号'] }}</span>
              <span>{{ gear['装备名称'] }}</span>
              <span class="gear-spec">{{ gear['规格型号'] }}</span>
            </li>
          </ul>
          <p v-else class="gear-empty">该林场暂无可用器材</p>
        </article>
      </div>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条扑火队伍记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  listUsableEquipment,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { storageKey as storageKeyOfEntries } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('fireteam')
const columns = ["队伍编号", "队伍名称", "所属林场", "队长姓名", "队员人数", "集结半径", "值班状态", "出动状态"]
const actions = ["下达出动", "转入休整", "撤回队伍"]
const statuses = ["在营待命", "已出动", "扑救中", "已撤回", "休整中"]
const stats = [{"label": "队伍总数", "value": 0}, {"label": "待命队伍", "value": 0}, {"label": "出动队伍", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 可用器材按保管林场分组缓存，队伍卡片按所属林场直接查
const usableGear = ref<EntryRow[]>([])
const usableGearByFarm = computed(() => {
  const grouped = new Map<string, EntryRow[]>()
  for (const gear of usableGear.value) {
    const farm = String(gear['保管林场'] ?? '')
    const list = grouped.get(farm) ?? []
    list.push(gear)
    grouped.set(farm, list)
  }
  return grouped
})

function usableGearFor(team: EntryRow): EntryRow[] {
  return usableGearByFarm.value.get(String(team['所属林场'] ?? '')) ?? []
}

function refreshUsableGear() {
  usableGear.value = listUsableEquipment()
}

function onStorage(event: StorageEvent) {
  // 另一个标签页改了装备（领用/送检/报废落地），清单跟着更新
  if (event.key === storageKeyOfEntries()) {
    refreshUsableGear()
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '扑火队伍登记入口尚未接入审批流'
}

async function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = await applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
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
    refreshUsableGear()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '扑火队伍列表读取失败'
  }
}

onMounted(() => {
  reload()
  window.addEventListener('storage', onStorage)
})

onBeforeUnmount(() => {
  window.removeEventListener('storage', onStorage)
})
</script>
