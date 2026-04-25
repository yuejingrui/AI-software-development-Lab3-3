<script setup lang="ts">
import { reactive, ref } from "vue";
import { RouterLink, useRouter } from "vue-router";
import PlanForm from "../components/PlanForm.vue";
import { apiPost } from "../lib/api";
import type { Plan, PlanPayload } from "../types/plan";

type FieldErrors = Partial<Record<keyof PlanPayload, string>>;

const router = useRouter();
const saving = ref(false);
const submitError = ref<string | null>(null);
const fieldErrors = ref<FieldErrors>({});

const draft = reactive<PlanPayload>({
  title: "",
  date: "",
  budget: 0,
  people_count: 1,
  preferences: "",
});

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

async function submit(): Promise<void> {
  submitError.value = null;
  const payload: PlanPayload = { ...draft };
  if (!validate(payload)) return;
  saving.value = true;
  try {
    const created = await apiPost<Plan>("/plans", payload);
    await router.push(`/plans/${created.id}`);
  } catch (e) {
    submitError.value = e instanceof Error ? e.message : "创建失败";
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <main class="container">
    <header class="header">
      <h1>新建规划</h1>
      <RouterLink class="back" to="/plans">返回列表</RouterLink>
    </header>

    <section class="card">
      <PlanForm
        :model-value="draft"
        :saving="saving"
        :field-errors="fieldErrors"
        submit-text="创建并进入详情"
        @update:model-value="Object.assign(draft, $event)"
        @submit="submit"
      />
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
.error {
  margin: 12px 0 0;
  color: #b91c1c;
}
</style>
