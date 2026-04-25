import { computed, ref } from "vue";

const message = ref<string | null>(null);

export function setGlobalError(next: string | null): void {
  message.value = next;
}

export const globalErrorMessage = computed(() => message.value);

