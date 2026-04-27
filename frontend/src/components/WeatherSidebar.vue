<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { fetchWeatherByLocation } from "../lib/weather";
import { fetchPlanRiskCheck } from "../lib/risk";
import type { PlanRiskCheck } from "../types/risk";
import type { WeatherByLocation, WeatherForecastDay } from "../types/weather";

const props = defineProps<{
  planId: number | null;
  riskReloadKey: number;
  longitude: number;
  latitude: number;
  placeName: string;
  planDate: string;
  allPlacesCount: number;
}>();
const emit = defineEmits<{
  requestShowAllPlaces: [];
}>();

const loading = ref(false);
const loadError = ref<string | null>(null);
const weather = ref<WeatherByLocation | null>(null);
const riskLoading = ref(false);
const riskLoadError = ref<string | null>(null);
const riskCheck = ref<PlanRiskCheck | null>(null);

const chartWidth = 320;
const chartHeight = 220;
const chartLeft = 26;
const chartRight = 26;
const chartTop = 24;
const tempBottom = 112;
const iconY = 150;
const dateY = 196;

const displayForecast = computed<WeatherForecastDay[]>(() => {
  if (!weather.value) return [];
  return weather.value.forecast.slice(0, 4);
});

const tempBounds = computed(() => {
  const allTemps = displayForecast.value.flatMap((item) => [item.high_temp_c, item.low_temp_c]);
  if (allTemps.length === 0) return { min: 0, max: 1 };
  const min = Math.min(...allTemps);
  const max = Math.max(...allTemps);
  if (min === max) {
    return { min: min - 1, max: max + 1 };
  }
  return { min, max };
});

function pointX(index: number, total: number): number {
  if (total <= 1) return chartLeft;
  const usable = chartWidth - chartLeft - chartRight;
  return chartLeft + (index * usable) / (total - 1);
}

function pointY(temp: number): number {
  const bounds = tempBounds.value;
  const ratio = (temp - bounds.min) / (bounds.max - bounds.min);
  return tempBottom - ratio * (tempBottom - chartTop);
}

const highLinePoints = computed(() => {
  return displayForecast.value
    .map((item, index) => `${pointX(index, displayForecast.value.length)},${pointY(item.high_temp_c)}`)
    .join(" ");
});

const lowLinePoints = computed(() => {
  return displayForecast.value
    .map((item, index) => `${pointX(index, displayForecast.value.length)},${pointY(item.low_temp_c)}`)
    .join(" ");
});

function formatDateLabel(dateText: string): string {
  const date = new Date(`${dateText}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dateText;
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${month}/${day}`;
}

function weatherIconKind(weatherText: string): "sunny" | "rain" | "cloud" {
  if (weatherText.includes("雨")) return "rain";
  if (weatherText.includes("晴")) return "sunny";
  return "cloud";
}

const hasPlanDate = computed(() => Boolean(props.planDate && props.planDate.trim().length > 0));
const hasPlanDateForecast = computed(() => {
  if (!hasPlanDate.value) return true;
  return displayForecast.value.some((item) => item.date === props.planDate);
});

async function loadWeather(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    weather.value = await fetchWeatherByLocation(props.longitude, props.latitude);
  } catch (e) {
    weather.value = null;
    loadError.value = e instanceof Error ? e.message : "天气加载失败";
  } finally {
    loading.value = false;
  }
}

async function loadRiskCheck(): Promise<void> {
  if (props.planId === null || props.planId < 1) {
    riskCheck.value = null;
    riskLoadError.value = null;
    return;
  }
  riskLoading.value = true;
  riskLoadError.value = null;
  try {
    riskCheck.value = await fetchPlanRiskCheck(props.planId);
  } catch (e) {
    riskCheck.value = null;
    riskLoadError.value = e instanceof Error ? e.message : "规则检查失败";
  } finally {
    riskLoading.value = false;
  }
}

watch(
  () => [props.longitude, props.latitude],
  () => {
    loadWeather();
  },
  { immediate: true }
);

watch(
  () => [props.planId, props.riskReloadKey],
  () => {
    loadRiskCheck();
  },
  { immediate: true }
);
</script>

<template>
  <aside class="weather-panel">
    <h2>天气摘要</h2>
    <p class="selected-place">{{ placeName || "未命名地点" }}</p>

    <div v-if="loading" class="status">天气加载中...</div>
    <div v-else-if="loadError" class="status error">
      <p>{{ loadError }}</p>
      <button type="button" class="btn" @click="loadWeather">重试天气加载</button>
    </div>
    <template v-else-if="weather">
      <section class="current">
        <p class="location">{{ weather.province }} {{ weather.city }} {{ weather.district }}</p>
        <p class="temp">{{ Math.round(weather.current.temperature_c) }}°C</p>
        <p class="weather">{{ weather.current.weather }}</p>
        <p class="meta">风向：{{ weather.current.wind_direction }}</p>
        <p class="meta">风速：{{ weather.current.wind_speed_mps.toFixed(1) }} m/s</p>
      </section>

      <section class="forecast">
        <h3>今天及未来 3 天</h3>
        <p v-if="displayForecast.length === 0" class="status">暂无天气预报数据</p>
        <svg
          v-else
          class="chart"
          :viewBox="`0 0 ${chartWidth} ${chartHeight}`"
          role="img"
          aria-label="未来四天天气趋势"
        >
          <polyline :points="highLinePoints" class="line high" />
          <polyline :points="lowLinePoints" class="line low" />

          <g v-for="(day, index) in displayForecast" :key="day.date">
            <circle :cx="pointX(index, displayForecast.length)" :cy="pointY(day.high_temp_c)" r="3.5" class="dot high" />
            <circle :cx="pointX(index, displayForecast.length)" :cy="pointY(day.low_temp_c)" r="3.5" class="dot low" />
            <text
              :x="pointX(index, displayForecast.length)"
              :y="pointY(day.high_temp_c) - 8"
              class="label high"
              text-anchor="middle"
            >
              {{ Math.round(day.high_temp_c) }}°
            </text>
            <text
              :x="pointX(index, displayForecast.length)"
              :y="pointY(day.low_temp_c) + 14"
              class="label low"
              text-anchor="middle"
            >
              {{ Math.round(day.low_temp_c) }}°
            </text>

            <g :transform="`translate(${pointX(index, displayForecast.length) - 8}, ${iconY - 8})`">
              <circle v-if="weatherIconKind(day.weather) === 'sunny'" cx="8" cy="8" r="5.5" class="icon-sun" />
              <g v-else-if="weatherIconKind(day.weather) === 'rain'">
                <ellipse cx="8" cy="7" rx="6.2" ry="4.5" class="icon-cloud" />
                <line x1="5" y1="12" x2="5" y2="16" class="icon-rain" />
                <line x1="8" y1="12" x2="8" y2="16" class="icon-rain" />
                <line x1="11" y1="12" x2="11" y2="16" class="icon-rain" />
              </g>
              <ellipse v-else cx="8" cy="8" rx="6.5" ry="4.8" class="icon-cloud" />
            </g>

            <text :x="pointX(index, displayForecast.length)" :y="iconY + 24" class="weather-text" text-anchor="middle">
              {{ day.weather }}
            </text>
            <text :x="pointX(index, displayForecast.length)" :y="dateY" class="date-text" text-anchor="middle">
              {{ formatDateLabel(day.date) }}
            </text>
          </g>
        </svg>
        <p v-if="hasPlanDate && !hasPlanDateForecast" class="status warn">暂无该日的天气信息</p>
      </section>

      <section class="risk-panel">
        <div class="risk-header">
          <h3>风险提示区</h3>
          <button type="button" class="btn" :disabled="riskLoading" @click="loadRiskCheck">
            {{ riskLoading ? "检查中..." : "刷新检查" }}
          </button>
        </div>

        <p v-if="riskLoadError" class="status error">{{ riskLoadError }}</p>
        <p v-else-if="riskLoading" class="status">规则检查中...</p>
        <template v-else-if="riskCheck">
          <div class="risk-item">
            <p class="risk-title">雨天户外风险</p>
            <p class="risk-value" :class="riskCheck.weather_risk.has_rain_or_snow ? 'warn' : 'ok'">
              {{ riskCheck.weather_risk.suggestion }}
            </p>
            <p v-if="riskCheck.weather_risk.matched_weather" class="risk-meta">
              规划日天气：{{ riskCheck.weather_risk.matched_weather }}
            </p>
            <p v-if="!riskCheck.weather_risk.has_forecast_for_plan_date" class="status warn">规划日期暂无可用天气预报</p>
          </div>
        </template>
        <div class="history-places-action">
          <button type="button" class="btn" :disabled="allPlacesCount === 0" @click="emit('requestShowAllPlaces')">
            所有历史规划地点
          </button>
          <p v-if="allPlacesCount === 0" class="status">暂无可展示的历史地点</p>
        </div>
      </section>
    </template>
  </aside>
</template>

<style scoped>
.weather-panel {
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  background: #fff;
  padding: 14px;
  display: grid;
  gap: 12px;
}
h2,
h3 {
  margin: 0;
}
.selected-place {
  margin: 0;
  color: #111827;
  font-weight: 600;
}
.status {
  margin: 0;
  color: #6b7280;
}
.status.error {
  color: #b91c1c;
}
.status.warn {
  color: #b45309;
}
.current {
  display: grid;
  gap: 4px;
  padding: 10px;
  border-radius: 10px;
  background: #f8fafc;
}
.location {
  margin: 0;
  color: #374151;
  font-size: 13px;
}
.temp {
  margin: 0;
  line-height: 1;
  font-size: 44px;
  font-weight: 700;
  color: #111827;
}
.weather {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
  color: #111827;
}
.meta {
  margin: 0;
  color: #4b5563;
  font-size: 13px;
}
.forecast {
  display: grid;
  gap: 8px;
}
.risk-panel {
  display: grid;
  gap: 10px;
  border-top: 1px solid #e5e7eb;
  padding-top: 10px;
}
.risk-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.risk-item {
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 10px;
  display: grid;
  gap: 4px;
  background: #f9fafb;
}
.history-places-action {
  display: grid;
  gap: 6px;
  padding-top: 4px;
}
.risk-title {
  margin: 0;
  color: #374151;
  font-size: 13px;
}
.risk-value {
  margin: 0;
  font-weight: 700;
  color: #111827;
}
.risk-value.ok {
  color: #166534;
}
.risk-value.warn {
  color: #b45309;
}
.risk-meta {
  margin: 0;
  color: #4b5563;
  font-size: 13px;
}
.chart {
  width: 100%;
  display: block;
}
.line {
  fill: none;
  stroke-width: 2;
}
.line.high {
  stroke: #ef4444;
}
.line.low {
  stroke: #3b82f6;
}
.dot {
  stroke-width: 1;
}
.dot.high {
  fill: #ef4444;
  stroke: #fff;
}
.dot.low {
  fill: #3b82f6;
  stroke: #fff;
}
.label {
  font-size: 11px;
  font-weight: 600;
}
.label.high {
  fill: #b91c1c;
}
.label.low {
  fill: #1d4ed8;
}
.weather-text,
.date-text {
  font-size: 11px;
  fill: #374151;
}
.icon-sun {
  fill: #f59e0b;
}
.icon-cloud {
  fill: #94a3b8;
}
.icon-rain {
  stroke: #0ea5e9;
  stroke-width: 1.6;
  stroke-linecap: round;
}
.btn {
  border: 1px solid #d1d5db;
  background: #fff;
  color: #111827;
  padding: 8px 12px;
  border-radius: 8px;
  cursor: pointer;
}
</style>
