<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { apiPost } from "../lib/api";

type AiSummaryResult = {
  reply: string;
  strengths: string[];
  risks: string[];
  improvements: string[];
  used_weather_fallback: boolean;
};

type ChatRole = "user" | "assistant";

type ChatMessage = {
  role: ChatRole;
  content: string;
  strengths?: string[];
  risks?: string[];
  improvements?: string[];
  createdAt: string;
};

type ChatSession = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
};

const props = withDefaults(
  defineProps<{
    planId: number | null;
    planTitle: string;
  }>(),
  {
    planId: null,
    planTitle: "未命名规划",
  }
);

const sessions = ref<ChatSession[]>([]);
const activeSessionId = ref<string>("");
const historyExpanded = ref(false);
const sending = ref(false);
const input = ref("");
const chatError = ref<string | null>(null);

function nowIso(): string {
  return new Date().toISOString();
}

function safePlanTitle(): string {
  const title = props.planTitle.trim();
  return title || "未命名规划";
}

function buildStorageKey(planId: number | null): string {
  if (planId === null) return "lab3-ai-chat-v1:unknown";
  return `lab3-ai-chat-v1:plan-${planId}`;
}

function createSession(name: string): ChatSession {
  const now = nowIso();
  return {
    id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

function loadSessionsFromStorage(planId: number | null): void {
  const key = buildStorageKey(planId);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      const first = createSession(safePlanTitle());
      sessions.value = [first];
      activeSessionId.value = first.id;
      return;
    }
    const parsed = JSON.parse(raw) as ChatSession[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      const first = createSession(safePlanTitle());
      sessions.value = [first];
      activeSessionId.value = first.id;
      return;
    }
    sessions.value = parsed.filter((item) => Array.isArray(item.messages));
    if (sessions.value.length === 0) {
      const first = createSession(safePlanTitle());
      sessions.value = [first];
      activeSessionId.value = first.id;
      return;
    }
    activeSessionId.value = sessions.value[0].id;
  } catch {
    const first = createSession(safePlanTitle());
    sessions.value = [first];
    activeSessionId.value = first.id;
  }
}

function saveSessionsToStorage(): void {
  const key = buildStorageKey(props.planId);
  localStorage.setItem(key, JSON.stringify(sessions.value));
}

const activeSession = computed<ChatSession | null>(() => {
  return sessions.value.find((item) => item.id === activeSessionId.value) || null;
});

const latestAssistantSummary = computed<ChatMessage | null>(() => {
  const current = activeSession.value;
  if (!current) return null;
  for (let i = current.messages.length - 1; i >= 0; i -= 1) {
    const message = current.messages[i];
    if (message.role === "assistant") return message;
  }
  return null;
});

function startNewSession(): void {
  const created = createSession(safePlanTitle());
  sessions.value = [created, ...sessions.value];
  activeSessionId.value = created.id;
  historyExpanded.value = false;
  saveSessionsToStorage();
}

function switchSession(sessionId: string): void {
  activeSessionId.value = sessionId;
  historyExpanded.value = false;
}

function updateActiveSession(mutator: (session: ChatSession) => void): void {
  const current = activeSession.value;
  if (!current) return;
  mutator(current);
  current.updatedAt = nowIso();
  sessions.value = [...sessions.value].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  saveSessionsToStorage();
}

function buildHistoryPayload(messages: ChatMessage[]): Array<{ role: ChatRole; content: string }> {
  return messages
    .filter((message) => message.content.trim())
    .slice(-10)
    .map((message) => ({ role: message.role, content: message.content }));
}

async function sendQuestion(): Promise<void> {
  chatError.value = null;
  if (props.planId === null) {
    chatError.value = "规划尚未加载完成，暂不可发起 AI 总结。";
    return;
  }
  const question = input.value.trim();
  if (!question) {
    chatError.value = "请输入想让 AI 分析的问题。";
    return;
  }
  if (!activeSession.value) {
    startNewSession();
  }
  const historyBefore = buildHistoryPayload(activeSession.value?.messages || []);
  const userMessage: ChatMessage = {
    role: "user",
    content: question,
    createdAt: nowIso(),
  };
  updateActiveSession((session) => {
    session.messages.push(userMessage);
    session.name = safePlanTitle();
  });
  input.value = "";
  sending.value = true;
  try {
    const result = await apiPost<AiSummaryResult>(`/plans/${props.planId}/ai-summary`, {
      question,
      history: historyBefore,
    });
    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: result.reply,
      strengths: result.strengths,
      risks: result.risks,
      improvements: result.improvements,
      createdAt: nowIso(),
    };
    updateActiveSession((session) => {
      session.messages.push(assistantMessage);
    });
  } catch (e) {
    chatError.value = e instanceof Error ? e.message : "AI 总结失败，请稍后再试";
  } finally {
    sending.value = false;
  }
}

watch(
  () => props.planId,
  (next) => {
    loadSessionsFromStorage(next);
  },
  { immediate: true }
);

watch(
  () => props.planTitle,
  () => {
    if (!activeSession.value) return;
    updateActiveSession((session) => {
      session.name = safePlanTitle();
    });
  }
);
</script>

<template>
  <section class="ai-panel card">
    <header class="head">
      <div>
        <h2>AI 辅助总结</h2>
        <p class="muted">基于当前规划信息给出优点、风险与改进建议。</p>
      </div>
      <div class="actions">
        <button type="button" class="btn small" @click="historyExpanded = !historyExpanded">
          {{ historyExpanded ? "收起历史" : "展开历史" }}
        </button>
        <button type="button" class="btn small primary" @click="startNewSession">新对话</button>
      </div>
    </header>

    <div v-if="historyExpanded" class="history-list">
      <button
        v-for="session in sessions"
        :key="session.id"
        type="button"
        class="history-item"
        :class="{ active: session.id === activeSessionId }"
        @click="switchSession(session.id)"
      >
        <strong>{{ session.name }}</strong>
        <span>{{ new Date(session.updatedAt).toLocaleString() }}</span>
      </button>
    </div>

    <div class="chat-box">
      <p v-if="!activeSession || activeSession.messages.length === 0" class="muted">
        还没有聊天记录。可以先问“请帮我检查这份行程是否超预算”。
      </p>
      <ul v-else class="chat-list">
        <li v-for="(message, index) in activeSession.messages" :key="`${message.createdAt}-${index}`" class="chat-item">
          <p class="role" :class="message.role === 'user' ? 'user' : 'assistant'">
            {{ message.role === "user" ? "我" : "AI" }}
          </p>
          <p class="content">{{ message.content }}</p>
        </li>
      </ul>
    </div>

    <section v-if="latestAssistantSummary" class="summary">
      <h3>建议摘要</h3>
      <div class="summary-grid">
        <div class="summary-card">
          <h4>优点</h4>
          <ul>
            <li v-for="(item, idx) in latestAssistantSummary.strengths || []" :key="`s-${idx}`">{{ item }}</li>
          </ul>
        </div>
        <div class="summary-card">
          <h4>风险</h4>
          <ul>
            <li v-for="(item, idx) in latestAssistantSummary.risks || []" :key="`r-${idx}`">{{ item }}</li>
          </ul>
        </div>
        <div class="summary-card">
          <h4>改进点</h4>
          <ul>
            <li v-for="(item, idx) in latestAssistantSummary.improvements || []" :key="`i-${idx}`">{{ item }}</li>
          </ul>
        </div>
      </div>
    </section>

    <div class="composer">
      <textarea
        v-model.trim="input"
        rows="4"
        maxlength="2000"
        placeholder="输入你的问题，例如：请结合天气和预算给我优化建议"
        :disabled="sending"
      />
      <button type="button" class="btn primary" :disabled="sending || !input.trim()" @click="sendQuestion">
        {{ sending ? "生成中..." : "发送给 AI" }}
      </button>
    </div>
    <p v-if="chatError" class="error">{{ chatError }}</p>
  </section>
</template>

<style scoped>
.card {
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  background: #fff;
  padding: 14px;
}
.ai-panel {
  display: grid;
  gap: 10px;
}
.head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
h2,
h3,
h4 {
  margin: 0;
}
.actions {
  display: flex;
  gap: 8px;
}
.history-list {
  display: grid;
  gap: 6px;
}
.history-item {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 8px;
  text-align: left;
  display: grid;
  gap: 2px;
  background: #fff;
  cursor: pointer;
}
.history-item.active {
  border-color: #2563eb;
}
.history-item span {
  color: #6b7280;
  font-size: 12px;
}
.chat-box {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #f8fafc;
  padding: 8px;
  max-height: 360px;
  overflow: auto;
}
.chat-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 8px;
}
.chat-item {
  border: 1px solid #dbeafe;
  border-radius: 8px;
  background: #fff;
  padding: 8px;
  display: grid;
  gap: 4px;
}
.role {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
}
.role.user {
  color: #1d4ed8;
}
.role.assistant {
  color: #0f766e;
}
.content {
  margin: 0;
  white-space: pre-wrap;
}
.summary {
  display: grid;
  gap: 8px;
}
.summary-grid {
  display: grid;
  gap: 8px;
}
.summary-card {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 8px;
}
.summary-card ul {
  margin: 6px 0 0;
  padding-left: 18px;
  display: grid;
  gap: 4px;
}
.composer {
  display: grid;
  gap: 8px;
}
.composer textarea {
  border: 1px solid #d1d5db;
  border-radius: 8px;
  padding: 8px;
  font: inherit;
  resize: vertical;
}
.btn {
  border: 1px solid #d1d5db;
  background: #fff;
  color: #111827;
  padding: 8px 12px;
  border-radius: 8px;
  cursor: pointer;
}
.btn.primary {
  background: #2563eb;
  border-color: #2563eb;
  color: #fff;
}
.btn.small {
  padding: 4px 8px;
  font-size: 12px;
}
.muted {
  margin: 0;
  color: #6b7280;
}
.error {
  margin: 0;
  color: #b91c1c;
}
</style>
