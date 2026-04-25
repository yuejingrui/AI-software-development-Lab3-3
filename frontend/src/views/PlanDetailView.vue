<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";
import PlanForm from "../components/PlanForm.vue";
import { assertAmapKeyReady, loadAmapSdk, reverseGeocode, searchPoi } from "../lib/amap";
import { apiDelete, apiGet, apiPost, apiPut } from "../lib/api";
import type { AMapGlobal, AMapMapLike, AMapMarkerLike } from "../types/amap";
import type { Place, PlacePayload } from "../types/place";
import type { Plan, PlanPayload } from "../types/plan";

type PlanFieldErrors = Partial<Record<keyof PlanPayload, string>>;
type PlaceFieldErrors = Partial<Record<keyof PlacePayload, string>>;

const route = useRoute();

const loading = ref(false);
const saving = ref(false);
const loadError = ref<string | null>(null);
const submitError = ref<string | null>(null);
const saveTip = ref<string | null>(null);
const planId = ref<number | null>(null);
const createdAt = ref("");
const updatedAt = ref("");
const fieldErrors = ref<PlanFieldErrors>({});

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

const mapContainerId = "amap-container";
const mapReady = ref(false);
const mapError = ref<string | null>(null);
let mapInstance: AMapMapLike | null = null;
let pickMarker: AMapMarkerLike | null = null;
const placeMarkerMap = new Map<number, AMapMarkerLike>();

const placeDraft = reactive<PlacePayload>({
  name: "",
  address: "",
  longitude: 121.4737,
  latitude: 31.2304,
});
const placeErrors = ref<PlaceFieldErrors>({});
const placeSaving = ref(false);
const placeLoading = ref(false);
const placeError = ref<string | null>(null);
const placeTip = ref<string | null>(null);
const editingPlaceId = ref<number | null>(null);

const searchKeyword = ref("");
const searchLoading = ref(false);
const searchError = ref<string | null>(null);
const searchResults = ref<PlacePayload[]>([]);

const planPlaces = ref<Place[]>([]);
const allPlaces = ref<Place[]>([]);

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
  const nextErrors: PlanFieldErrors = {};
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

function validatePlace(payload: PlacePayload): boolean {
  const nextErrors: PlaceFieldErrors = {};
  if (!payload.name.trim()) nextErrors.name = "请输入地点名称";
  if (!payload.address.trim()) nextErrors.address = "请输入地点地址";
  if (!Number.isFinite(payload.longitude) || payload.longitude < -180 || payload.longitude > 180) {
    nextErrors.longitude = "经度范围应在 -180 到 180";
  }
  if (!Number.isFinite(payload.latitude) || payload.latitude < -90 || payload.latitude > 90) {
    nextErrors.latitude = "纬度范围应在 -90 到 90";
  }
  placeErrors.value = nextErrors;
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

function clearPlaceMarkers(): void {
  if (!mapInstance) return;
  for (const marker of placeMarkerMap.values()) {
    mapInstance.remove(marker);
  }
  placeMarkerMap.clear();
}

function updatePickMarker(payload: PlacePayload): void {
  if (!mapInstance) return;
  if (!pickMarker) {
    pickMarker = new window.AMap!.Marker({
      position: [payload.longitude, payload.latitude],
      label: { content: "待加入地点", direction: "top" },
    });
    mapInstance.add(pickMarker);
    return;
  }
  pickMarker.setPosition([payload.longitude, payload.latitude]);
}

function centerToPlace(payload: PlacePayload, zoom = 14): void {
  if (!mapInstance) return;
  mapInstance.setZoomAndCenter(zoom, [payload.longitude, payload.latitude]);
  updatePickMarker(payload);
}

function renderAllPlaceMarkers(): void {
  if (!mapInstance || !window.AMap) return;
  clearPlaceMarkers();
  for (const place of allPlaces.value) {
    const marker = new window.AMap.Marker({
      position: [place.longitude, place.latitude],
      title: `${place.name} (${place.plan_title || "未知规划"})`,
      label: {
        content: `${place.name}`,
        direction: "top",
      },
    });
    marker.on?.("click", () => {
      centerToPlace(place);
    });
    placeMarkerMap.set(place.id, marker);
    mapInstance.add(marker);
  }
}

async function onMapPicked(longitude: number, latitude: number): Promise<void> {
  placeDraft.longitude = Number(longitude.toFixed(6));
  placeDraft.latitude = Number(latitude.toFixed(6));
  if (!placeDraft.name.trim()) {
    placeDraft.name = `地点 ${placeDraft.longitude}, ${placeDraft.latitude}`;
  }
  const addr = await reverseGeocode(placeDraft.longitude, placeDraft.latitude);
  if (addr) {
    placeDraft.address = addr;
  }
  centerToPlace(placeDraft);
}

async function initMap(): Promise<void> {
  const keyError = await assertAmapKeyReady();
  if (keyError) {
    mapError.value = keyError;
    return;
  }
  mapError.value = null;
  let AMap: AMapGlobal;
  try {
    AMap = await loadAmapSdk();
  } catch (e) {
    mapError.value = e instanceof Error ? e.message : "地图初始化失败";
    return;
  }
  const container = document.getElementById(mapContainerId);
  if (!container) {
    mapError.value = "地图容器初始化失败";
    return;
  }
  mapInstance = new AMap.Map(container, {
    zoom: 11,
    center: [placeDraft.longitude, placeDraft.latitude],
    resizeEnable: true,
  });
  mapInstance.on("click", (event: any) => {
    const longitude = Number(event?.lnglat?.lng ?? event?.lnglat?.getLng?.());
    const latitude = Number(event?.lnglat?.lat ?? event?.lnglat?.getLat?.());
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return;
    onMapPicked(longitude, latitude);
  });
  mapReady.value = true;
}

function setPlaceDraft(place: PlacePayload): void {
  placeDraft.name = place.name;
  placeDraft.address = place.address;
  placeDraft.longitude = place.longitude;
  placeDraft.latitude = place.latitude;
  centerToPlace(placeDraft);
}

function resetPlaceForm(): void {
  placeErrors.value = {};
  editingPlaceId.value = null;
  placeDraft.name = "";
  placeDraft.address = "";
  placeTip.value = null;
}

function startEditPlace(place: Place): void {
  editingPlaceId.value = place.id;
  setPlaceDraft({
    name: place.name,
    address: place.address,
    longitude: place.longitude,
    latitude: place.latitude,
  });
  placeTip.value = `正在编辑地点 #${place.id}`;
}

async function loadPlaces(): Promise<void> {
  if (planId.value === null) return;
  placeLoading.value = true;
  placeError.value = null;
  try {
    const [inPlan, all] = await Promise.all([
      apiGet<Place[]>(`/plans/${planId.value}/places`),
      apiGet<Place[]>("/places"),
    ]);
    planPlaces.value = inPlan;
    allPlaces.value = all;
    renderAllPlaceMarkers();
  } catch (e) {
    placeError.value = e instanceof Error ? e.message : "加载地点失败";
  } finally {
    placeLoading.value = false;
  }
}

async function submitPlace(): Promise<void> {
  if (planId.value === null) {
    placeError.value = "规划 ID 不存在";
    return;
  }
  placeError.value = null;
  placeTip.value = null;
  const payload: PlacePayload = { ...placeDraft };
  if (!validatePlace(payload)) return;
  placeSaving.value = true;
  try {
    if (editingPlaceId.value === null) {
      await apiPost<Place>(`/plans/${planId.value}/places`, payload);
      placeTip.value = "地点已加入当前规划";
    } else {
      await apiPut<Place>(`/places/${editingPlaceId.value}`, payload);
      placeTip.value = "地点修改成功";
    }
    await loadPlaces();
    resetPlaceForm();
  } catch (e) {
    placeError.value = e instanceof Error ? e.message : "保存地点失败";
  } finally {
    placeSaving.value = false;
  }
}

async function removePlace(placeId: number): Promise<void> {
  placeError.value = null;
  placeTip.value = null;
  try {
    await apiDelete<{ deleted: boolean }>(`/places/${placeId}`);
    if (editingPlaceId.value === placeId) {
      resetPlaceForm();
    }
    await loadPlaces();
    placeTip.value = "地点已删除";
  } catch (e) {
    placeError.value = e instanceof Error ? e.message : "删除地点失败";
  }
}

async function searchAndPick(): Promise<void> {
  searchError.value = null;
  searchResults.value = [];
  const keyword = searchKeyword.value.trim();
  if (!keyword) {
    searchError.value = "请输入地点关键词";
    return;
  }
  searchLoading.value = true;
  try {
    const candidates = await searchPoi(keyword);
    searchResults.value = candidates;
    if (candidates.length === 0) {
      searchError.value = "未搜索到地点";
      return;
    }
    setPlaceDraft(candidates[0]);
    placeTip.value = "已自动选中搜索结果第一个地点";
  } catch (e) {
    searchError.value = e instanceof Error ? e.message : "搜索失败";
  } finally {
    searchLoading.value = false;
  }
}

function showPlanPlacesOnMap(): void {
  if (!mapInstance || planPlaces.value.length === 0) return;
  const overlays = planPlaces.value
    .map((place) => placeMarkerMap.get(place.id))
    .filter((v): v is AMapMarkerLike => Boolean(v));
  if (overlays.length > 0) mapInstance.setFitView(overlays);
}

function showAllPlacesOnMap(): void {
  if (!mapInstance || placeMarkerMap.size === 0) return;
  mapInstance.setFitView([...placeMarkerMap.values()]);
}

function locatePlace(place: Place): void {
  setPlaceDraft({
    name: place.name,
    address: place.address,
    longitude: place.longitude,
    latitude: place.latitude,
  });
}

onMounted(async () => {
  await loadPlan();
  if (loadError.value) return;
  await nextTick();
  await initMap();
  await loadPlaces();
});

onBeforeUnmount(() => {
  if (mapInstance) {
    mapInstance.destroy();
    mapInstance = null;
  }
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

    <template v-else>
      <section class="card">
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

      <section class="card map-card">
        <div class="section-title-row">
          <h2>地点管理</h2>
          <div class="section-actions">
            <button type="button" class="btn" :disabled="planPlaces.length === 0" @click="showPlanPlacesOnMap">
              显示当前规划全部地点
            </button>
            <button type="button" class="btn" :disabled="allPlaces.length === 0" @click="showAllPlacesOnMap">
              显示任意规划全部地点
            </button>
          </div>
        </div>

        <p v-if="mapError" class="error">{{ mapError }}</p>
        <div :id="mapContainerId" class="map"></div>

        <div class="search">
          <input
            v-model.trim="searchKeyword"
            type="text"
            placeholder="搜索地点关键词，如：上海博物馆"
            :disabled="searchLoading"
          />
          <button type="button" class="btn primary" :disabled="searchLoading" @click="searchAndPick">
            {{ searchLoading ? "搜索中..." : "搜索并自动选中" }}
          </button>
        </div>
        <p v-if="searchError" class="error">{{ searchError }}</p>
        <div v-if="searchResults.length > 0" class="search-results">
          <button
            v-for="candidate in searchResults"
            :key="`${candidate.longitude},${candidate.latitude},${candidate.name}`"
            type="button"
            class="result-item"
            @click="setPlaceDraft(candidate)"
          >
            <strong>{{ candidate.name }}</strong>
            <span>{{ candidate.address }}</span>
          </button>
        </div>

        <form class="place-form" @submit.prevent="submitPlace">
          <div class="grid">
            <label>
              地点名称
              <input v-model.trim="placeDraft.name" type="text" maxlength="80" :disabled="placeSaving" />
              <span v-if="placeErrors.name" class="field-error">{{ placeErrors.name }}</span>
            </label>
            <label>
              地点地址
              <input v-model.trim="placeDraft.address" type="text" maxlength="200" :disabled="placeSaving" />
              <span v-if="placeErrors.address" class="field-error">{{ placeErrors.address }}</span>
            </label>
            <label>
              经度
              <input v-model.number="placeDraft.longitude" type="number" step="0.000001" :disabled="placeSaving" />
              <span v-if="placeErrors.longitude" class="field-error">{{ placeErrors.longitude }}</span>
            </label>
            <label>
              纬度
              <input v-model.number="placeDraft.latitude" type="number" step="0.000001" :disabled="placeSaving" />
              <span v-if="placeErrors.latitude" class="field-error">{{ placeErrors.latitude }}</span>
            </label>
          </div>

          <div class="actions">
            <button type="submit" class="btn primary" :disabled="placeSaving || !mapReady">
              {{
                placeSaving
                  ? "保存中..."
                  : editingPlaceId === null
                    ? "加入当前规划"
                    : `保存地点 #${editingPlaceId} 修改`
              }}
            </button>
            <button type="button" class="btn" :disabled="placeSaving" @click="resetPlaceForm">取消编辑</button>
            <button type="button" class="btn" :disabled="placeSaving" @click="centerToPlace(placeDraft)">
              在地图中显示待选点
            </button>
          </div>
        </form>

        <p v-if="placeLoading" class="muted">地点列表加载中...</p>
        <p v-if="placeError" class="error">{{ placeError }}</p>
        <p v-if="placeTip" class="tip">{{ placeTip }}</p>

        <div class="lists">
          <section class="sub-card">
            <h3>当前规划地点（{{ planPlaces.length }}）</h3>
            <p v-if="planPlaces.length === 0" class="muted">当前规划还没有地点，可在地图点击或搜索后加入。</p>
            <ul v-else class="place-list">
              <li v-for="place in planPlaces" :key="place.id" class="place-item">
                <button type="button" class="place-main" @click="locatePlace(place)">
                  <strong>{{ place.name }}</strong>
                  <span>{{ place.address }}</span>
                </button>
                <div class="item-actions">
                  <button type="button" class="btn small" @click="locatePlace(place)">显示</button>
                  <button type="button" class="btn small" @click="startEditPlace(place)">编辑</button>
                  <button type="button" class="btn small danger" @click="removePlace(place.id)">删除</button>
                </div>
              </li>
            </ul>
          </section>

          <section class="sub-card">
            <h3>任意规划地点（{{ allPlaces.length }}）</h3>
            <p v-if="allPlaces.length === 0" class="muted">暂无地点。</p>
            <ul v-else class="place-list">
              <li v-for="place in allPlaces" :key="`all-${place.id}`" class="place-item">
                <button type="button" class="place-main" @click="locatePlace(place)">
                  <strong>{{ place.plan_title || "未知规划" }} / {{ place.name }}</strong>
                  <span>{{ place.address }}</span>
                </button>
                <div class="item-actions">
                  <button type="button" class="btn small" @click="locatePlace(place)">显示</button>
                  <button type="button" class="btn small" @click="startEditPlace(place)">编辑</button>
                  <button type="button" class="btn small danger" @click="removePlace(place.id)">删除</button>
                </div>
              </li>
            </ul>
          </section>
        </div>
      </section>
    </template>
  </main>
</template>

<style scoped>
.container {
  max-width: 1080px;
  margin: 32px auto;
  padding: 0 16px 24px;
}
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}
h1,
h2,
h3 {
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
  margin-bottom: 12px;
}
.map-card {
  display: grid;
  gap: 12px;
}
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin-bottom: 16px;
  color: #6b7280;
  font-size: 14px;
}
.section-title-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.section-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.map {
  width: 100%;
  min-height: 360px;
  border-radius: 10px;
  border: 1px solid #e5e7eb;
  overflow: hidden;
}
.search {
  display: flex;
  gap: 8px;
}
.search input {
  flex: 1;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  padding: 8px 10px;
}
.search-results {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 8px;
}
.result-item {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #fff;
  text-align: left;
  display: grid;
  gap: 4px;
  padding: 8px;
  cursor: pointer;
}
.result-item:hover {
  border-color: #2563eb;
}
.place-form {
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 12px;
  display: grid;
  gap: 10px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
}
.grid label {
  display: grid;
  gap: 6px;
  font-size: 14px;
  color: #374151;
}
.grid input {
  border: 1px solid #d1d5db;
  border-radius: 8px;
  padding: 8px 10px;
  font: inherit;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.lists {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 10px;
}
.sub-card {
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 10px;
  display: grid;
  gap: 8px;
}
.place-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 8px;
}
.place-item {
  border: 1px solid #edf2f7;
  border-radius: 8px;
  padding: 8px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.place-main {
  text-align: left;
  border: none;
  background: transparent;
  display: grid;
  gap: 4px;
  cursor: pointer;
  color: #111827;
}
.place-main span {
  color: #6b7280;
  font-size: 13px;
}
.item-actions {
  display: flex;
  gap: 6px;
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
.btn.danger {
  border-color: #ef4444;
  color: #b91c1c;
}
.tip {
  margin: 0;
  color: #065f46;
}
.error {
  margin: 0;
  color: #b91c1c;
}
.muted {
  margin: 0;
  color: #6b7280;
}
.field-error {
  color: #b91c1c;
  font-size: 12px;
}
</style>
