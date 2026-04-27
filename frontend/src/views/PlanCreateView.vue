<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { RouterLink, useRouter } from "vue-router";
import PlanForm from "../components/PlanForm.vue";
import { assertAmapKeyReady, loadAmapSdk, nearbyPoi, reverseGeocode, searchPoi } from "../lib/amap";
import { apiPost } from "../lib/api";
import type { AMapGlobal, AMapMapLike, AMapMarkerLike } from "../types/amap";
import type { Place, PlacePayload } from "../types/place";
import type { Plan, PlanPayload } from "../types/plan";

type FieldErrors = Partial<Record<keyof PlanPayload, string>>;

const router = useRouter();
const saving = ref(false);
const submitError = ref<string | null>(null);
const fieldErrors = ref<FieldErrors>({});
const mapContainerId = "create-amap-container";
const mapReady = ref(false);
const mapError = ref<string | null>(null);
const placeError = ref<string | null>(null);
const searchKeyword = ref("");
const searchLoading = ref(false);
const searchError = ref<string | null>(null);
const searchResults = ref<PlacePayload[]>([]);
const SEARCH_DEBOUNCE_MS = 250;
let searchDebounceTimer: number | null = null;
const pendingPlaces = ref<PlacePayload[]>([]);
const HOTSPOT_CLICK_SUPPRESS_MS = 300;
let mapInstance: AMapMapLike | null = null;
let pickMarker: AMapMarkerLike | null = null;
let lastHotspotClickAt = 0;
const pendingPlaceMarkers: AMapMarkerLike[] = [];

const placeDraft = reactive<PlacePayload>({
  name: "",
  address: "",
  longitude: 121.4737,
  latitude: 31.2304,
});

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

function centerToPlace(payload: PlacePayload, zoom = 14): void {
  if (!mapInstance) return;
  mapInstance.setZoomAndCenter(zoom, [payload.longitude, payload.latitude]);
}

function ensureMapCenteredInViewport(): void {
  const container = document.getElementById(mapContainerId);
  if (!container) return;
  const rect = container.getBoundingClientRect();
  const fullyVisible =
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= window.innerHeight &&
    rect.right <= window.innerWidth;
  if (fullyVisible) return;
  container.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
}

function updatePickMarker(payload: PlacePayload): void {
  if (!mapInstance) return;
  const markerLabel = payload.name.trim() || payload.address.trim() || "未命名地点";
  if (!pickMarker) {
    pickMarker = new window.AMap!.Marker({
      position: [payload.longitude, payload.latitude],
      label: { content: markerLabel, direction: "top" },
    });
    mapInstance.add(pickMarker);
    return;
  }
  pickMarker.setPosition([payload.longitude, payload.latitude]);
  pickMarker.setLabel?.({ content: markerLabel, direction: "top" });
}

function setPlaceDraft(place: PlacePayload): void {
  placeDraft.name = place.name;
  placeDraft.address = place.address;
  placeDraft.longitude = place.longitude;
  placeDraft.latitude = place.latitude;
  updatePickMarker(placeDraft);
  centerToPlace(placeDraft);
}

type MapPickPayload = {
  longitude: number;
  latitude: number;
  name: string;
  address: string;
  source: "hotspot" | "map";
};

async function onMapPicked(pick: MapPickPayload): Promise<void> {
  placeError.value = null;
  placeDraft.longitude = Number(pick.longitude.toFixed(6));
  placeDraft.latitude = Number(pick.latitude.toFixed(6));
  try {
    const geocode = await reverseGeocode(placeDraft.longitude, placeDraft.latitude);
    if (pick.source === "hotspot") {
      placeDraft.name = pick.name || geocode.name || geocode.address || "未命名地点";
      placeDraft.address = pick.address || geocode.address || geocode.name || "地址未知";
    } else {
      const nearby = await nearbyPoi(placeDraft.longitude, placeDraft.latitude);
      placeDraft.name = pick.name || nearby?.name?.trim() || geocode.name || geocode.address || "未命名地点";
      placeDraft.address = pick.address || nearby?.address?.trim() || geocode.address || geocode.name || "地址未知";
    }
  } catch (e) {
    placeDraft.name = pick.name || "未命名地点";
    placeDraft.address = pick.address || "地址未知";
    placeError.value = e instanceof Error ? e.message : "地点解析失败";
  }
  updatePickMarker(placeDraft);
  centerToPlace(placeDraft);
  ensureMapCenteredInViewport();
}

function parseMapPickEvent(event: any, source: "hotspot" | "map"): MapPickPayload | null {
  const longitude = Number(event?.lnglat?.lng ?? event?.lnglat?.getLng?.());
  const latitude = Number(event?.lnglat?.lat ?? event?.lnglat?.getLat?.());
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  const name = String(event?.poi?.name ?? event?.name ?? "").trim();
  const address = String(event?.poi?.address ?? event?.poi?.addr ?? event?.address ?? "").trim();
  return { longitude, latitude, name, address, source };
}

function renderPendingPlaceMarkers(): void {
  if (!mapInstance || !window.AMap) return;
  if (pendingPlaceMarkers.length > 0) {
    mapInstance.remove(pendingPlaceMarkers);
    pendingPlaceMarkers.length = 0;
  }
  for (const place of pendingPlaces.value) {
    const marker = new window.AMap.Marker({
      position: [place.longitude, place.latitude],
      label: { content: place.name, direction: "top" },
    });
    marker.on?.("click", () => {
      setPlaceDraft(place);
    });
    pendingPlaceMarkers.push(marker);
  }
  if (pendingPlaceMarkers.length > 0) {
    mapInstance.add(pendingPlaceMarkers);
  }
}

function addPendingPlace(): void {
  placeError.value = null;
  const payload: PlacePayload = {
    name: placeDraft.name.trim(),
    address: placeDraft.address.trim(),
    longitude: placeDraft.longitude,
    latitude: placeDraft.latitude,
  };
  if (!payload.name || !payload.address) {
    placeError.value = "请先在地图上选点或搜索地点，确保地点名称与地址完整";
    return;
  }
  pendingPlaces.value.unshift(payload);
  renderPendingPlaceMarkers();
}

function removePendingPlace(index: number): void {
  pendingPlaces.value.splice(index, 1);
  renderPendingPlaceMarkers();
}

async function performSearch(keyword: string): Promise<void> {
  searchError.value = null;
  searchResults.value = [];
  if (!keyword) {
    return;
  }
  searchLoading.value = true;
  try {
    const candidates = await searchPoi(keyword);
    searchResults.value = candidates.slice(0, 5);
    if (candidates.length === 0) {
      searchError.value = "未搜索到地点";
      return;
    }
    setPlaceDraft(candidates[0]);
  } catch (e) {
    searchError.value = e instanceof Error ? e.message : "搜索失败";
  } finally {
    searchLoading.value = false;
  }
}

function clearSearch(): void {
  searchKeyword.value = "";
  searchError.value = null;
  searchResults.value = [];
  if (searchDebounceTimer !== null) {
    window.clearTimeout(searchDebounceTimer);
    searchDebounceTimer = null;
  }
}

watch(searchKeyword, (value) => {
  const keyword = value.trim();
  searchError.value = null;
  if (searchDebounceTimer !== null) {
    window.clearTimeout(searchDebounceTimer);
    searchDebounceTimer = null;
  }
  if (!keyword) {
    searchResults.value = [];
    searchLoading.value = false;
    return;
  }
  searchDebounceTimer = window.setTimeout(() => {
    searchDebounceTimer = null;
    void performSearch(keyword);
  }, SEARCH_DEBOUNCE_MS);
});

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
    isHotspot: true,
    features: ["bg", "road", "building", "point"],
  });
  mapInstance.on("hotspotclick", (event: any) => {
    const parsed = parseMapPickEvent(event, "hotspot");
    if (!parsed) return;
    lastHotspotClickAt = Date.now();
    onMapPicked(parsed);
  });
  mapInstance.on("click", (event: any) => {
    if (Date.now() - lastHotspotClickAt < HOTSPOT_CLICK_SUPPRESS_MS) return;
    const parsed = parseMapPickEvent(event, "map");
    if (!parsed) return;
    onMapPicked(parsed);
  });
  mapReady.value = true;
}

async function submit(): Promise<void> {
  submitError.value = null;
  const payload: PlanPayload = { ...draft };
  if (!validate(payload)) return;
  saving.value = true;
  try {
    const created = await apiPost<Plan>("/plans", payload);
    if (pendingPlaces.value.length > 0) {
      await Promise.all(
        pendingPlaces.value.map((place) => apiPost<Place>(`/plans/${created.id}/places`, place))
      );
    }
    await router.push(`/plans/${created.id}`);
  } catch (e) {
    submitError.value = e instanceof Error ? e.message : "创建失败";
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  await nextTick();
  await initMap();
});

onBeforeUnmount(() => {
  if (searchDebounceTimer !== null) {
    window.clearTimeout(searchDebounceTimer);
    searchDebounceTimer = null;
  }
  if (mapInstance) {
    mapInstance.destroy();
    mapInstance = null;
  }
});
</script>

<template>
  <main class="container">
    <header class="header">
      <h1>新建规划</h1>
      <RouterLink class="back" to="/plans">查看所有规划</RouterLink>
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

    <section class="card map-card">
      <h2>地点预选</h2>
      <p class="muted">创建规划前也可先在地图选点，创建后将自动加入本规划。</p>

      <p v-if="mapError" class="error">{{ mapError }}</p>
      <div :id="mapContainerId" class="map"></div>

      <div class="search">
        <input
          v-model.trim="searchKeyword"
          type="text"
          placeholder="搜索地点关键词，如：上海虹桥国际机场"
          :disabled="searchLoading"
        />
        <button type="button" class="btn clear" :disabled="searchLoading && !searchKeyword" @click="clearSearch">
          ×
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
          <span>{{ candidate.name }} - {{ candidate.address }}</span>
        </button>
      </div>

      <div class="place-form">
        <label>
          地点名称
          <input v-model.trim="placeDraft.name" type="text" maxlength="80" :disabled="saving" />
        </label>
        <label>
          地点地址
          <input v-model.trim="placeDraft.address" type="text" maxlength="200" :disabled="saving" />
        </label>
        <div class="actions">
          <button type="button" class="btn primary" :disabled="saving || !mapReady" @click="addPendingPlace">
            添加到待创建清单
          </button>
        </div>
      </div>
      <p v-if="placeError" class="error">{{ placeError }}</p>

      <div>
        <h3>待创建地点（{{ pendingPlaces.length }}）</h3>
        <p v-if="pendingPlaces.length === 0" class="muted">暂无待创建地点。</p>
        <ul v-else class="place-list">
          <li
            v-for="(place, index) in pendingPlaces"
            :key="`${place.longitude},${place.latitude},${place.name},${index}`"
            class="place-item"
          >
            <button type="button" class="place-main" @click="setPlaceDraft(place)">
              <strong>{{ place.name }}</strong>
              <span>{{ place.address }}</span>
            </button>
            <div class="item-actions">
              <button type="button" class="btn small" @click="setPlaceDraft(place)">显示</button>
              <button type="button" class="btn small danger" @click="removePendingPlace(index)">移除</button>
            </div>
          </li>
        </ul>
      </div>
    </section>
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
  margin-bottom: 12px;
}
.map-card {
  display: grid;
  gap: 12px;
}
.map {
  width: 100%;
  aspect-ratio: 2 / 1;
  min-height: 300px;
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
  font: inherit;
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
  padding: 8px;
  cursor: pointer;
  color: #6b7280;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.result-item:hover {
  border-color: #2563eb;
}
.btn.clear {
  min-width: 36px;
  padding: 8px 10px;
  font-size: 18px;
  line-height: 1;
}
.place-form {
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 12px;
  display: grid;
  gap: 10px;
}
.place-form label {
  display: grid;
  gap: 6px;
  font-size: 14px;
  color: #374151;
}
.place-form input {
  border: 1px solid #d1d5db;
  border-radius: 8px;
  padding: 8px 10px;
  font: inherit;
}
.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
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
.error {
  margin: 0;
  color: #b91c1c;
}
.muted {
  margin: 0;
  color: #6b7280;
}
</style>
