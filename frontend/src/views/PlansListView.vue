<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { apiDelete, apiGet, apiPut } from "../lib/api";
import type { Plan } from "../types/plan";

const router = useRouter();
const loading = ref(false);
const errorMessage = ref<string | null>(null);
const plans = ref<Plan[]>([]);

type SortBy = "name" | "time";
type SortOrder = "asc" | "desc";
const sortBy = ref<SortBy>("time");
const sortOrder = ref<SortOrder>("desc");

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const utc8 = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const year = utc8.getUTCFullYear();
  const month = String(utc8.getUTCMonth() + 1).padStart(2, "0");
  const day = String(utc8.getUTCDate()).padStart(2, "0");
  const hour = String(utc8.getUTCHours()).padStart(2, "0");
  const minute = String(utc8.getUTCMinutes()).padStart(2, "0");
  const second = String(utc8.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

const sortedPlans = computed<Plan[]>(() => {
  const list = [...plans.value];
  const pinned = list.filter((p) => p.pinned);
  const unpinned = list.filter((p) => !p.pinned);

  const cmp = (a: Plan, b: Plan): number => {
    if (sortBy.value === "name") {
      return a.title.localeCompare(b.title, "zh");
    }
    return new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime();
  };

  unpinned.sort((a, b) => (sortOrder.value === "asc" ? cmp(a, b) : cmp(b, a)));
  return [...pinned, ...unpinned];
});

async function loadPlans(): Promise<void> {
  loading.value = true;
  errorMessage.value = null;
  try {
    plans.value = await apiGet<Plan[]>("/plans");
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : "加载规划失败";
  } finally {
    loading.value = false;
  }
}

async function deletePlan(id: number, event: Event): Promise<void> {
  event.stopPropagation();
  if (!window.confirm("确定要删除该规划吗？此操作不可恢复。")) return;
  try {
    await apiDelete<{ deleted: boolean }>(`/plans/${id}`);
    plans.value = plans.value.filter((p) => p.id !== id);
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : "删除失败";
  }
}

async function togglePin(plan: Plan, event: Event): Promise<void> {
  event.stopPropagation();
  try {
    const updated = await apiPut<Plan>(`/plans/${plan.id}/pin`, {});
    const idx = plans.value.findIndex((p) => p.id === plan.id);
    if (idx !== -1) plans.value[idx] = updated;
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : "操作失败";
  }
}

function goToPlan(id: number): void {
  router.push(`/plans/${id}`);
}

function setSort(by: SortBy, order: SortOrder): void {
  sortBy.value = by;
  sortOrder.value = order;
}

onMounted(() => {
  loadPlans();
});
</script>

<template>
  <main class="container">
    <header class="header">
      <h1>规划列表</h1>
      <RouterLink class="btn primary" to="/plans/new">新建规划</RouterLink>
    </header>

    <section v-if="loading" class="card">加载中...</section>

    <section v-else-if="errorMessage" class="card">
      <p class="error">{{ errorMessage }}</p>
      <button type="button" class="btn" @click="loadPlans">重试</button>
    </section>

    <section v-else-if="plans.length === 0" class="card">
      <p>还没有规划，先创建一个吧。</p>
      <RouterLink class="btn primary" to="/plans/new">去新建</RouterLink>
    </section>

    <template v-else>
      <div class="toolbar">
        <span class="toolbar-label">排序：</span>
        <button
          type="button"
          class="sort-btn"
          :class="{ active: sortBy === 'name' && sortOrder === 'asc' }"
          @click="setSort('name', 'asc')"
        >名称 ↑</button>
        <button
          type="button"
          class="sort-btn"
          :class="{ active: sortBy === 'name' && sortOrder === 'desc' }"
          @click="setSort('name', 'desc')"
        >名称 ↓</button>
        <button
          type="button"
          class="sort-btn"
          :class="{ active: sortBy === 'time' && sortOrder === 'asc' }"
          @click="setSort('time', 'asc')"
        >时间 ↑</button>
        <button
          type="button"
          class="sort-btn"
          :class="{ active: sortBy === 'time' && sortOrder === 'desc' }"
          @click="setSort('time', 'desc')"
        >时间 ↓</button>
      </div>

      <section class="list">
        <div
          v-for="plan in sortedPlans"
          :key="plan.id"
          class="card item"
          @click="goToPlan(plan.id)"
        >
          <div class="top">
            <h2>
              <span v-if="plan.pinned" class="pin-badge">[顶]</span>
              {{ plan.title }}
            </h2>
            <div class="actions">
              <button
                type="button"
                class="icon-btn"
                @click="togglePin(plan, $event)"
              >{{ plan.pinned ? '取消置顶' : '置顶' }}</button>
              <button
                type="button"
                class="icon-btn danger"
                @click="deletePlan(plan.id, $event)"
              >删除</button>
            </div>
          </div>
          <div class="meta">日期：{{ plan.date }}</div>
          <div class="meta">预算：{{ plan.budget }} 元</div>
          <div class="meta">人数：{{ plan.people_count }} 人</div>
          <div class="meta muted">更新时间：{{ formatDateTime(plan.updated_at) }}</div>
        </div>
      </section>
    </template>
  </main>
</template>

<style scoped>
.container {
  max-width: 760px;
  margin: 32px auto;
  padding: 0 16px 24px;
}
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
h1,
h2 {
  margin: 0;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.toolbar-label {
  font-size: 14px;
  color: #6b7280;
  margin-right: 4px;
}
.sort-btn {
  border: 1px solid #d1d5db;
  background: #fff;
  color: #374151;
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
}
.sort-btn:hover {
  border-color: #2563eb;
  color: #2563eb;
}
.sort-btn.active {
  border-color: #2563eb;
  background: #2563eb;
  color: #fff;
}
.list {
  display: grid;
  gap: 12px;
}
.card {
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 14px;
  background: #fff;
}
.item {
  color: inherit;
  text-decoration: none;
  cursor: pointer;
}
.item:hover {
  border-color: #2563eb;
}
.top {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 8px;
}
.pin-badge {
  margin-right: 4px;
}
.actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
  margin-left: 8px;
}
.icon-btn {
  border: 1px solid #d1d5db;
  background: #fff;
  border-radius: 6px;
  padding: 2px 6px;
  font-size: 14px;
  cursor: pointer;
  line-height: 1.4;
}
.icon-btn:hover {
  border-color: #2563eb;
}
.icon-btn.danger:hover {
  border-color: #dc2626;
  background: #fef2f2;
}
.meta {
  color: #374151;
  margin-top: 4px;
}
.muted {
  color: #6b7280;
}
.btn {
  border: 1px solid #d1d5db;
  background: #fff;
  color: #111827;
  padding: 8px 12px;
  border-radius: 8px;
  text-decoration: none;
  cursor: pointer;
}
.btn.primary {
  border-color: #2563eb;
  background: #2563eb;
  color: #fff;
}
.error {
  color: #b91c1c;
}
</style>
