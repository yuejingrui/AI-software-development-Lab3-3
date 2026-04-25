<script setup lang="ts">
import { globalErrorMessage, setGlobalError } from "./stores/error";
</script>

<template>
  <div class="app">
    <div v-if="globalErrorMessage" class="error">
      <span class="msg">{{ globalErrorMessage }}</span>
      <button type="button" class="close" @click="setGlobalError(null)">关闭</button>
    </div>
    <router-view />
  </div>
</template>

<style scoped>
.app {
  min-height: 100vh;
}
.error {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid #f2caca;
  background: #fff5f5;
  color: #8a1f1f;
}
.msg {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.close {
  border: 1px solid #f2caca;
  background: #fff;
  padding: 6px 10px;
  border-radius: 8px;
  cursor: pointer;
}
</style>

