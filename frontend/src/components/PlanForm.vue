<script setup lang="ts">
import type { PlanPayload } from "../types/plan";

type FieldErrors = Partial<Record<keyof PlanPayload, string>>;

const props = withDefaults(
  defineProps<{
    modelValue: PlanPayload;
    submitText: string;
    saving?: boolean;
    fieldErrors?: FieldErrors;
    showReset?: boolean;
  }>(),
  {
    saving: false,
    fieldErrors: () => ({}),
    showReset: false,
  }
);

const emit = defineEmits<{
  "update:modelValue": [value: PlanPayload];
  submit: [];
  reset: [];
}>();

function updateField<K extends keyof PlanPayload>(key: K, value: PlanPayload[K]): void {
  emit("update:modelValue", { ...props.modelValue, [key]: value });
}

function onSubmit(): void {
  emit("submit");
}

function onTextInput(key: "title" | "date" | "preferences", event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
    return;
  }
  updateField(key, target.value);
}

function onNumberInput(key: "people_count" | "budget", event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }
  updateField(key, Number(target.value));
}
</script>

<template>
  <form class="form" @submit.prevent="onSubmit">
    <div class="field">
      <label for="title">规划标题</label>
      <input
        id="title"
        :value="modelValue.title"
        type="text"
        maxlength="50"
        placeholder="例如：周末上海亲子游"
        :disabled="saving"
        @input="onTextInput('title', $event)"
      />
      <p v-if="fieldErrors.title" class="error">{{ fieldErrors.title }}</p>
    </div>

    <div class="grid">
      <div class="field">
        <label for="date">日期</label>
        <input
          id="date"
          :value="modelValue.date"
          type="date"
          :disabled="saving"
          @input="onTextInput('date', $event)"
        />
        <p v-if="fieldErrors.date" class="error">{{ fieldErrors.date }}</p>
      </div>

      <div class="field">
        <label for="peopleCount">人数</label>
        <input
          id="peopleCount"
          :value="modelValue.people_count"
          type="number"
          min="1"
          step="1"
          :disabled="saving"
          @input="onNumberInput('people_count', $event)"
        />
        <p v-if="fieldErrors.people_count" class="error">{{ fieldErrors.people_count }}</p>
      </div>

      <div class="field">
        <label for="budget">预算（元）</label>
        <input
          id="budget"
          :value="modelValue.budget"
          type="number"
          min="0"
          step="1"
          :disabled="saving"
          @input="onNumberInput('budget', $event)"
        />
        <p v-if="fieldErrors.budget" class="error">{{ fieldErrors.budget }}</p>
      </div>
    </div>

    <div class="field">
      <label for="preferences">偏好</label>
      <textarea
        id="preferences"
        :value="modelValue.preferences"
        maxlength="500"
        rows="4"
        placeholder="例如：清淡饮食、亲子友好、尽量户外"
        :disabled="saving"
        @input="onTextInput('preferences', $event)"
      />
      <p v-if="fieldErrors.preferences" class="error">{{ fieldErrors.preferences }}</p>
    </div>

    <div class="actions">
      <button type="submit" class="btn primary" :disabled="saving">
        {{ saving ? "保存中..." : submitText }}
      </button>
      <button v-if="showReset" type="button" class="btn" :disabled="saving" @click="emit('reset')">
        放弃更改
      </button>
    </div>
  </form>
</template>

<style scoped>
.form {
  display: grid;
  gap: 16px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}
.field {
  display: grid;
  gap: 6px;
}
label {
  font-size: 14px;
  color: #374151;
}
input,
textarea {
  width: 100%;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  padding: 8px 10px;
  font: inherit;
  box-sizing: border-box;
}
input:focus,
textarea:focus {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
}
.actions {
  display: flex;
  gap: 12px;
}
.btn {
  border: 1px solid #d1d5db;
  background: #fff;
  color: #111827;
  padding: 8px 14px;
  border-radius: 8px;
  cursor: pointer;
}
.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.btn.primary {
  background: #2563eb;
  border-color: #2563eb;
  color: #fff;
}
.error {
  margin: 0;
  color: #b91c1c;
  font-size: 13px;
}
</style>
