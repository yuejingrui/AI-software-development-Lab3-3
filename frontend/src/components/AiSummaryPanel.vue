<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from "vue";
import { apiPost, apiPostStream } from "../lib/api";

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
const streaming = ref(false);
const input = ref("");
const chatError = ref<string | null>(null);
const collapsedMessageKeys = reactive(new Set<string>());

function messageKey(message: ChatMessage, index: number): string {
  return `${message.createdAt}-${index}`;
}

function toggleMessageCollapse(key: string): void {
  if (collapsedMessageKeys.has(key)) {
    collapsedMessageKeys.delete(key);
  } else {
    collapsedMessageKeys.add(key);
  }
}

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
    if (message.role === "assistant" && (message.strengths?.length || message.risks?.length || message.improvements?.length)) {
      return message;
    }
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

function scrollChatToBottom(): void {
  nextTick(() => {
    const box = document.querySelector(".chat-box");
    if (box) box.scrollTop = box.scrollHeight;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function playTypewriter(
  message: ChatMessage,
  result: AiSummaryResult
): Promise<void> {
  const reply = (result.reply || "").trim();
  message.content = "";
  if (!reply) {
    message.strengths = result.strengths;
    message.risks = result.risks;
    message.improvements = result.improvements;
    return;
  }

  const fastChars = 24;
  for (let i = 0; i < reply.length; i += 1) {
    message.content += reply[i];
    if (i < fastChars || i % 3 === 0) {
      scrollChatToBottom();
    }
    await sleep(i < 80 ? 18 : 10);
  }
  message.strengths = result.strengths;
  message.risks = result.risks;
  message.improvements = result.improvements;
  scrollChatToBottom();
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
  const assistantMessage: ChatMessage = {
    role: "assistant",
    content: "",
    createdAt: nowIso(),
  };
  updateActiveSession((session) => {
    session.messages.push(userMessage);
    session.messages.push(assistantMessage);
    session.name = safePlanTitle();
  });
  input.value = "";
  sending.value = true;
  streaming.value = true;

  let streamSucceeded = false;
  try {
    await apiPostStream<AiSummaryResult>(
      `/plans/${props.planId}/ai-summary?stream=1`,
      { question, history: historyBefore },
      {
        onToken(text: string) {
          const session = activeSession.value;
          if (!session) return;
          const msgs = session.messages;
          const lastMsg = msgs[msgs.length - 1];
          if (lastMsg && lastMsg.role === "assistant") {
            lastMsg.content += text;
          }
          scrollChatToBottom();
        },
        onDone(result: AiSummaryResult) {
          streamSucceeded = true;
          streaming.value = false;
          updateActiveSession((session) => {
            const msgs = session.messages;
            const lastMsg = msgs[msgs.length - 1];
            if (lastMsg && lastMsg.role === "assistant") {
              // Prefer the streamed content unless result.reply has more text
              if (result.reply && result.reply.length > (lastMsg.content || "").length) {
                lastMsg.content = result.reply;
              } else if (result.reply && !lastMsg.content) {
                lastMsg.content = result.reply;
              }
              lastMsg.strengths = result.strengths;
              lastMsg.risks = result.risks;
              lastMsg.improvements = result.improvements;
            }
          });
          scrollChatToBottom();
        },
        onError(message: string) {
          streaming.value = false;
          chatError.value = message;
          updateActiveSession((session) => {
            const msgs = session.messages;
            const lastMsg = msgs[msgs.length - 1];
            if (lastMsg && lastMsg.role === "assistant" && !lastMsg.content.trim()) {
              lastMsg.content = "AI 回复生成失败";
            }
          });
        },
      }
    );
  } catch (e) {
    streaming.value = false;
    // SSE failed — fall back to non-streaming API with typewriter effect
    if (!streamSucceeded) {
      try {
        const result = await apiPost<AiSummaryResult>(`/plans/${props.planId}/ai-summary`, {
          question,
          history: historyBefore,
        });
        updateActiveSession((session) => {
          const msgs = session.messages;
          const lastMsg = msgs[msgs.length - 1];
          if (!lastMsg || lastMsg.role !== "assistant") return;
          lastMsg.strengths = [];
          lastMsg.risks = [];
          lastMsg.improvements = [];
        });
        streaming.value = true;
        const session = activeSession.value;
        const lastMsg = session?.messages[session.messages.length - 1];
        if (lastMsg && lastMsg.role === "assistant") {
          await playTypewriter(lastMsg, result);
          saveSessionsToStorage();
        }
      } catch (e2) {
        chatError.value = e2 instanceof Error ? e2.message : "AI 总结失败，请稍后再试";
        updateActiveSession((session) => {
          const msgs = session.messages;
          const lastMsg = msgs[msgs.length - 1];
          if (lastMsg && lastMsg.role === "assistant" && !lastMsg.content.trim()) {
            lastMsg.content = "AI 回复生成失败";
          }
        });
      }
    }
  } finally {
    sending.value = false;
    streaming.value = false;
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
        还没有聊天记录。可以先问"请帮我检查这份行程是否超预算"。
      </p>
      <ul v-else class="chat-list">
        <li
          v-for="(message, index) in activeSession.messages"
          :key="`${message.createdAt}-${index}`"
          class="chat-item"
          :class="message.role === 'user' ? 'chat-user' : 'chat-assistant'"
        >
          <p class="role" :class="message.role === 'user' ? 'user' : 'assistant'">
            {{ message.role === "user" ? "我" : "AI" }}
          </p>
          <p
            class="content"
            :class="{ streaming: streaming && message.role === 'assistant' && index === activeSession.messages.length - 1 }"
          >
            <template v-if="message.role === 'assistant' && !streaming && collapsedMessageKeys.has(messageKey(message, index))">
              {{ message.content.slice(0, 200) }}...
            </template>
            <template v-else>
              {{ message.content }}
            </template>
            <span
              v-if="streaming && message.role === 'assistant' && index === activeSession.messages.length - 1 && message.content"
              class="cursor-blink"
              >|</span
            >
          </p>
          <button
            v-if="message.role === 'assistant' && message.content.length > 300 && !streaming"
            type="button"
            class="toggle-btn"
            @click="toggleMessageCollapse(messageKey(message, index))"
          >
            {{ collapsedMessageKeys.has(messageKey(message, index)) ? "展开全文 ▼" : "收起 ▲" }}
          </button>
        </li>
      </ul>
    </div>

    <section v-if="latestAssistantSummary && !streaming" class="summary">
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
        {{ streaming ? "AI 生成中..." : sending ? "生成中..." : "发送给 AI" }}
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
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  background: #fff;
  padding: 8px;
  display: grid;
  gap: 4px;
  max-width: 92%;
}
.chat-user {
  justify-self: end;
  background: #dbeafe;
  border-color: #bfdbfe;
}
.chat-assistant {
  justify-self: start;
  background: #f8fafc;
  border-color: #cbd5e1;
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
  font-size: 13px;
  line-height: 1.45;
}
.content.streaming {
  border-left: 2px solid #2563eb;
  padding-left: 6px;
}
.cursor-blink {
  color: #2563eb;
  font-weight: 700;
  animation: blink 0.8s infinite;
}
@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
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
.toggle-btn {
  background: none;
  border: none;
  color: #2563eb;
  font-size: 12px;
  cursor: pointer;
  padding: 2px 0;
  text-align: left;
}
.toggle-btn:hover {
  color: #1d4ed8;
  text-decoration: underline;
}
.error {
  margin: 0;
  color: #b91c1c;
}
</style>
