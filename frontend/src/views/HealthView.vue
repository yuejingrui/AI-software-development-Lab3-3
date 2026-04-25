<script setup lang="ts">
import { onMounted, ref } from "vue";
import { apiGet } from "../lib/api";
import { setGlobalError } from "../stores/error";

type HealthData = { status: string; db: string };

const loading = ref(false);
const health = ref<HealthData | null>(null);

async function refresh(): Promise<void> {
  setGlobalError(null);
  loading.value = true;
  try {
    health.value = await apiGet<HealthData>("/health");
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  refresh();
});
</script>

<template>
  <main class="container">
    <h1>健康检查</h1>
    <div class="actions">
      <button type="button" class="btn" :disabled="loading" @click="refresh">
        {{ loading ? "请求中..." : "刷新" }}
      </button>
    </div>
    <section v-if="health" class="card">
      <div class="row">
        <span class="label">服务状态</span>
        <span class="value">{{ health.status }}</span>
      </div>
      <div class="row">
        <span class="label">数据库</span>
        <span class="value">{{ health.db }}</span>
      </div>
    </section>
    <section v-else class="card">
      <div class="row">
        <span class="label">服务状态</span>
        <span class="value">未知</span>
      </div>
    </section>
  </main>
</template>

<style scoped>
.container {
  max-width: 720px;
  margin: 40px auto;
  padding: 0 16px;
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica,
    Arial, "Apple Color Emoji", "Segoe UI Emoji";
}
.actions {
  margin: 12px 0 16px;
}
.btn {
  border: 1px solid #ddd;
  background: #fff;
  padding: 8px 12px;
  border-radius: 8px;
  cursor: pointer;
}
.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.card {
  border: 1px solid #eee;
  border-radius: 12px;
  padding: 12px;
}
.row {
  display: flex;
  justify-content: space-between;
  padding: 8px 0;
}
.label {
  color: #555;
}
.value {
  font-weight: 600;
}
</style>

