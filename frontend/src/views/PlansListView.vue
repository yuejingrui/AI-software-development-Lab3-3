<script setup lang="ts">
import { onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { apiGet } from "../lib/api";
import type { Plan } from "../types/plan";

const loading = ref(false);
const errorMessage = ref<string | null>(null);
const plans = ref<Plan[]>([]);

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

    <section v-else class="list">
      <RouterLink v-for="plan in plans" :key="plan.id" class="card item" :to="`/plans/${plan.id}`">
        <div class="top">
          <h2>{{ plan.title }}</h2>
          <span>#{{
            plan.id
          }}</span>
        </div>
        <div class="meta">日期：{{ plan.date }}</div>
        <div class="meta">预算：{{ plan.budget }} 元</div>
        <div class="meta">人数：{{ plan.people_count }} 人</div>
        <div class="meta muted">更新时间：{{ plan.updated_at }}</div>
      </RouterLink>
    </section>
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
