<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";
import PlanForm from "../components/PlanForm.vue";
import { apiGet, apiPut } from "../lib/api";
import type { Plan, PlanPayload } from "../types/plan";

type FieldErrors = Partial<Record<keyof PlanPayload, string>>;

const route = useRoute();
const loading = ref(false);
const saving = ref(false);
const loadError = ref<string | null>(null);
const submitError = ref<string | null>(null);
const saveTip = ref<string | null>(null);
const planId = ref<number | null>(null);
const createdAt = ref("");
const updatedAt = ref("");
const fieldErrors = ref<FieldErrors>({});

const draft = reactive<PlanPayload>({
  title: "",
  date: "",
  budget: 0,
  people_count: 1,
  preferences: "",
});
const lastSaved = reactive<PlanPayload>({
  title: "",
  date: "",
  budget: 0,
  people_count: 1,
  preferences: "",
});

function toPayload(plan: Plan): PlanPayload {
  return {
    title: plan.title,
    date: plan.date,
    budget: plan.budget,
    people_count: plan.people_count,
    preferences: plan.preferences,
  };
}

function applyPayload(target: PlanPayload, payload: PlanPayload): void {
  Object.assign(target, payload);
}

function validate(payload: PlanPayload): boolean {
  const nextErrors: FieldErrors = {};
  if (!payload.title.trim()) nextErrors.title = "请输入规划标题";
  if (!payload.date.trim()) nextErrors.date = "请选择日期";
  if (!Number.isFinite(payload.budget) || payload.budget < 0) nextErrors.budget = "预算不能小于 0";
  if (!Number.isInteger(payload.people_count) || payload.people_count < 1) {
    nextErrors.people_count = "人数至少为 1";
  }
  if (payload.preferences.length > 500) nextErrors.preferences = "偏好最多 500 字";
  fieldErrors.value = nextErrors;
  return Object.keys(nextErrors).length === 0;
}

function parsePlanId(): number {
  const raw = String(route.params.id ?? "");
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("无效的规划 ID");
  }
  return parsed;
}

async function loadPlan(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  submitError.value = null;
  saveTip.value = null;
  try {
    const id = parsePlanId();
    planId.value = id;
    const plan = await apiGet<Plan>(`/plans/${id}`);
    const payload = toPayload(plan);
    applyPayload(draft, payload);
    applyPayload(lastSaved, payload);
    createdAt.value = plan.created_at;
    updatedAt.value = plan.updated_at;
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : "加载规划失败";
  } finally {
    loading.value = false;
  }
}

function reset(): void {
  applyPayload(draft, lastSaved);
  submitError.value = null;
  fieldErrors.value = {};
  saveTip.value = "已恢复到最近一次保存内容";
}

async function submit(): Promise<void> {
  submitError.value = null;
  saveTip.value = null;
  const id = planId.value;
  if (id === null) {
    submitError.value = "规划 ID 不存在";
    return;
  }
  const payload: PlanPayload = { ...draft };
  if (!validate(payload)) return;
  saving.value = true;
  try {
    const updated = await apiPut<Plan>(`/plans/${id}`, payload);
    const nextPayload = toPayload(updated);
    applyPayload(draft, nextPayload);
    applyPayload(lastSaved, nextPayload);
    updatedAt.value = updated.updated_at;
    saveTip.value = "已保存";
  } catch (e) {
    submitError.value = e instanceof Error ? e.message : "保存失败";
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  loadPlan();
});
</script>

<template>
  <main class="container">
    <header class="header">
      <h1>规划详情</h1>
      <RouterLink class="back" to="/plans">返回列表</RouterLink>
    </header>

    <section v-if="loading" class="card">加载中...</section>

    <section v-else-if="loadError" class="card">
      <p class="error">{{ loadError }}</p>
      <button type="button" class="btn" @click="loadPlan">重试</button>
    </section>

    <section v-else class="card">
      <div class="meta">
        <span v-if="planId !== null">规划 ID：{{ planId }}</span>
        <span>创建时间：{{ createdAt || "-" }}</span>
        <span>更新时间：{{ updatedAt || "-" }}</span>
      </div>

      <PlanForm
        :model-value="draft"
        :saving="saving"
        :show-reset="true"
        :field-errors="fieldErrors"
        submit-text="保存修改"
        @update:model-value="Object.assign(draft, $event)"
        @submit="submit"
        @reset="reset"
      />

      <p v-if="saveTip" class="tip">{{ saveTip }}</p>
      <p v-if="submitError" class="error">{{ submitError }}</p>
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
  margin-bottom: 16px;
}
h1 {
  margin: 0;
}
.back {
  color: #2563eb;
  text-decoration: none;
}
.card {
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 16px;
  background: #fff;
}
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin-bottom: 16px;
  color: #6b7280;
  font-size: 14px;
}
.btn {
  border: 1px solid #d1d5db;
  background: #fff;
  color: #111827;
  padding: 8px 12px;
  border-radius: 8px;
  cursor: pointer;
}
.tip {
  margin: 12px 0 0;
  color: #065f46;
}
.error {
  margin: 12px 0 0;
  color: #b91c1c;
}
</style>
