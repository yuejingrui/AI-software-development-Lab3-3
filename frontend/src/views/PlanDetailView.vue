<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import PlanForm from "../components/PlanForm.vue";
import AiSummaryPanel from "../components/AiSummaryPanel.vue";
import WeatherSidebar from "../components/WeatherSidebar.vue";
import { assertAmapKeyReady, loadAmapSdk, nearbyPoi, reverseGeocode, searchPoi } from "../lib/amap";
import { apiDelete, apiGet, apiPost, apiPut } from "../lib/api";
import type { AMapGlobal, AMapMapLike, AMapMarkerLike } from "../types/amap";
import type { ItinerarySlot, ItineraryUpdatePayload } from "../types/itinerary";
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
const SEARCH_DEBOUNCE_MS = 250;
let searchDebounceTimer: number | null = null;
const HOTSPOT_CLICK_SUPPRESS_MS = 300;
let lastHotspotClickAt = 0;

const planPlaces = ref<Place[]>([]);
const allPlaces = ref<Place[]>([]);
const mapScopeSelection = ref<"plan" | "all" | null>(null);
const riskCheckVersion = ref(0);
const itineraryLoading = ref(false);
const itinerarySaving = ref(false);
const itineraryError = ref<string | null>(null);
const itineraryTip = ref<string | null>(null);
const itinerarySlotPicker = reactive<Record<string, number | null>>({});
let itinerarySlotIdSeed = 0;

type ItineraryDraftSlot = {
  uid: string;
  id?: number;
  dayIndex: number;
  label: string;
  startMinute: number | null;
  endMinute: number | null;
  note: string;
  placeIds: number[];
  noteExpanded: boolean;
};

const itinerarySlots = ref<ItineraryDraftSlot[]>([]);
const planDays = ref(1);
const selectedDay = ref(1);

function bumpRiskCheckVersion(): void {
  riskCheckVersion.value += 1;
}

function newSlotUid(): string {
  itinerarySlotIdSeed += 1;
  return `slot-${Date.now()}-${itinerarySlotIdSeed}`;
}

function createDefaultSlots(dayIndex: number): ItineraryDraftSlot[] {
  return ["上午", "下午", "晚上"].map((label, index) => ({
    uid: newSlotUid(),
    dayIndex,
    label,
    startMinute: index === 0 ? 8 * 60 : index === 1 ? 13 * 60 : 18 * 60,
    endMinute: index === 0 ? 12 * 60 : index === 1 ? 17 * 60 : 21 * 60,
    note: "",
    placeIds: [],
    noteExpanded: false,
  }));
}

function dayDateText(dayIndex: number): string {
  const baseText = draft.date.trim();
  if (!baseText) return `第${dayIndex}天`;
  const baseDate = new Date(`${baseText}T00:00:00`);
  if (Number.isNaN(baseDate.getTime())) return `第${dayIndex}天`;
  baseDate.setDate(baseDate.getDate() + dayIndex - 1);
  const year = baseDate.getFullYear();
  const month = String(baseDate.getMonth() + 1).padStart(2, "0");
  const day = String(baseDate.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const currentDaySlots = computed(() => {
  return itinerarySlots.value.filter((slot) => slot.dayIndex === selectedDay.value);
});

function ensureDaySlots(dayIndex: number): void {
  if (itinerarySlots.value.some((slot) => slot.dayIndex === dayIndex)) return;
  itinerarySlots.value.push(...createDefaultSlots(dayIndex));
}

function setPlanDays(nextDays: number): void {
  const safeDays = Math.max(1, Math.min(30, Math.trunc(nextDays)));
  planDays.value = safeDays;
  itinerarySlots.value = itinerarySlots.value.filter((slot) => slot.dayIndex <= safeDays);
  for (let day = 1; day <= safeDays; day += 1) {
    ensureDaySlots(day);
  }
  if (selectedDay.value > safeDays) selectedDay.value = safeDays;
}

function replaceCurrentDaySlots(nextSlots: ItineraryDraftSlot[]): void {
  itinerarySlots.value = [
    ...itinerarySlots.value.filter((slot) => slot.dayIndex !== selectedDay.value),
    ...nextSlots.map((slot) => ({ ...slot, dayIndex: selectedDay.value })),
  ];
}

function minuteToTimeText(minute: number | null): string {
  if (minute === null) return "";
  const safe = Math.max(0, Math.min(minute, 1440));
  const hour = Math.floor(safe / 60);
  const min = safe % 60;
  return `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function timeTextToMinute(text: string): number | null {
  const normalized = text.trim();
  if (!normalized) return null;
  const parts = normalized.split(":");
  if (parts.length !== 2) return null;
  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 24 || minute < 0 || minute > 59) return null;
  if (hour === 24 && minute !== 0) return null;
  return hour * 60 + minute;
}

function slotTimeDisplay(slot: ItineraryDraftSlot): string {
  if (slot.startMinute === null || slot.endMinute === null) return slot.label;
  return `${minuteToTimeText(slot.startMinute)}-${minuteToTimeText(slot.endMinute)} ${slot.label}`;
}

function formatDateTime(value: string): string {
  if (!value.trim()) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function initItineraryDraft(slots: ItinerarySlot[]): void {
  if (slots.length === 0) {
    planDays.value = 1;
    selectedDay.value = 1;
    itinerarySlots.value = createDefaultSlots(1);
    return;
  }
  const maxDay = Math.max(1, ...slots.map((slot) => Math.max(1, slot.day_index)));
  planDays.value = maxDay;
  selectedDay.value = Math.min(selectedDay.value, maxDay);
  itinerarySlots.value = slots.map((slot) => ({
    uid: newSlotUid(),
    id: slot.id,
    dayIndex: Math.max(1, slot.day_index),
    label: slot.label,
    startMinute: slot.start_minute,
    endMinute: slot.end_minute,
    note: slot.note,
    placeIds: slot.places.map((item) => item.place_id),
    noteExpanded: false,
  }));
}

async function loadItinerary(): Promise<void> {
  if (planId.value === null) return;
  itineraryLoading.value = true;
  itineraryError.value = null;
  try {
    const data = await apiGet<ItinerarySlot[]>(`/plans/${planId.value}/itinerary`);
    initItineraryDraft(data);
  } catch (e) {
    itineraryError.value = e instanceof Error ? e.message : "加载时段行程失败";
  } finally {
    itineraryLoading.value = false;
  }
}

function validateItineraryDraft(): string | null {
  for (let dayIndex = 1; dayIndex <= planDays.value; dayIndex += 1) {
    const daySlots = itinerarySlots.value.filter((slot) => slot.dayIndex === dayIndex);
    if (daySlots.length === 0) return `第 ${dayIndex} 天至少保留一个时段`;
    const ranges: Array<{ start: number; end: number }> = [];
    for (let i = 0; i < daySlots.length; i += 1) {
      const slot = daySlots[i];
      if (!slot.label.trim()) return `第 ${dayIndex} 天第 ${i + 1} 个时段名称不能为空`;
      if ((slot.startMinute === null) !== (slot.endMinute === null)) return `第 ${dayIndex} 天第 ${i + 1} 个时段时间需同时填写开始和结束`;
      if (slot.startMinute !== null && slot.endMinute !== null) {
        if (slot.startMinute < 0 || slot.endMinute > 1440 || slot.startMinute >= slot.endMinute) {
          return `第 ${dayIndex} 天第 ${i + 1} 个时段时间非法`;
        }
        ranges.push({ start: slot.startMinute, end: slot.endMinute });
      }
    }
    ranges.sort((a, b) => a.start - b.start);
    for (let i = 1; i < ranges.length; i += 1) {
      if (ranges[i].start < ranges[i - 1].end) return `第 ${dayIndex} 天已设置时间的时段之间不能重叠`;
    }
  }
  return null;
}

async function saveItinerary(): Promise<void> {
  if (planId.value === null) {
    itineraryError.value = "规划 ID 不存在";
    return;
  }
  itineraryError.value = null;
  itineraryTip.value = null;
  const validationError = validateItineraryDraft();
  if (validationError) {
    itineraryError.value = validationError;
    return;
  }
  itinerarySaving.value = true;
  try {
    const slotsForSave: ItineraryDraftSlot[] = [];
    for (let dayIndex = 1; dayIndex <= planDays.value; dayIndex += 1) {
      const daySlots = itinerarySlots.value.filter((slot) => slot.dayIndex === dayIndex);
      daySlots.forEach((slot) => slotsForSave.push(slot));
    }
    const payload: ItineraryUpdatePayload = {
      slots: [],
    };
    for (let dayIndex = 1; dayIndex <= planDays.value; dayIndex += 1) {
      const daySlots = slotsForSave.filter((slot) => slot.dayIndex === dayIndex);
      daySlots.forEach((slot, index) => {
        payload.slots.push({
          id: slot.id,
          day_index: dayIndex,
          label: slot.label.trim(),
          start_minute: slot.startMinute,
          end_minute: slot.endMinute,
          sort_index: index,
          note: slot.note.trim(),
          place_ids: [...slot.placeIds],
        });
      });
    }
    const saved = await apiPut<ItinerarySlot[]>(`/plans/${planId.value}/itinerary`, payload);
    initItineraryDraft(saved);
    itineraryTip.value = "时段行程已保存";
  } catch (e) {
    itineraryError.value = e instanceof Error ? e.message : "保存时段行程失败";
  } finally {
    itinerarySaving.value = false;
  }
}
function addItinerarySlot(): void {
  const daySlots = [...currentDaySlots.value];
  daySlots.push({
    uid: newSlotUid(),
    dayIndex: selectedDay.value,
    label: `时段 ${daySlots.length + 1}`,
    startMinute: null,
    endMinute: null,
    note: "",
    placeIds: [],
    noteExpanded: true,
  });
  replaceCurrentDaySlots(daySlots);
}

function removeItinerarySlot(uid: string): void {
  const daySlots = currentDaySlots.value.filter((slot) => slot.uid !== uid);
  if (daySlots.length === 0) return;
  replaceCurrentDaySlots(daySlots);
}

function moveSlot(uid: string, direction: -1 | 1): void {
  const daySlots = [...currentDaySlots.value];
  const index = daySlots.findIndex((slot) => slot.uid === uid);
  if (index < 0) return;
  const target = index + direction;
  if (target < 0 || target >= daySlots.length) return;
  const next = [...daySlots];
  const [current] = next.splice(index, 1);
  next.splice(target, 0, current);
  replaceCurrentDaySlots(next);
}

function findPlaceInPlan(placeId: number): Place | null {
  return planPlaces.value.find((place) => place.id === placeId) || null;
}

function addPlaceToSlot(slotUid: string, placeId: number): void {
  const slot = itinerarySlots.value.find((item) => item.uid === slotUid);
  if (!slot) return;
  if (slot.placeIds.includes(placeId)) return;
  slot.placeIds.push(placeId);
}

function removePlaceFromSlot(slotUid: string, placeId: number): void {
  const slot = itinerarySlots.value.find((item) => item.uid === slotUid);
  if (!slot) return;
  slot.placeIds = slot.placeIds.filter((id) => id !== placeId);
}

function focusSlotOnMap(slot: ItineraryDraftSlot): void {
  if (!mapInstance || slot.placeIds.length === 0) return;
  const overlays = slot.placeIds
    .map((placeId) => placeMarkerMap.get(placeId))
    .filter((v): v is AMapMarkerLike => Boolean(v));
  if (overlays.length > 0) {
    mapInstance.setFitView(overlays);
    ensureMapCenteredInViewport();
  }
}

async function assignCurrentPickToSlot(slotUid: string): Promise<void> {
  if (planId.value === null) return;
  itineraryError.value = null;
  const payload: PlacePayload = { ...placeDraft };
  if (!validatePlace(payload)) {
    itineraryError.value = "当前选中地点信息不完整，无法分配到时段";
    return;
  }
  let place = planPlaces.value.find(
    (item) =>
      item.name === payload.name &&
      item.address === payload.address &&
      Math.abs(item.longitude - payload.longitude) < 0.000001 &&
      Math.abs(item.latitude - payload.latitude) < 0.000001
  );
  try {
    if (!place) {
      place = await apiPost<Place>(`/plans/${planId.value}/places`, payload);
      await loadPlaces();
    }
    addPlaceToSlot(slotUid, place.id);
    itineraryTip.value = "已将当前选中地点分配到时段";
  } catch (e) {
    itineraryError.value = e instanceof Error ? e.message : "分配当前地点失败";
  }
}

async function assignPlaceToSlot(slotUid: string): Promise<void> {
  itineraryError.value = null;
  itineraryTip.value = null;
  const selectedPlaceId = itinerarySlotPicker[slotUid];
  if (typeof selectedPlaceId === "number") {
    addPlaceToSlot(slotUid, selectedPlaceId);
    itineraryTip.value = "已将已选地点分配到时段";
    return;
  }
  await assignCurrentPickToSlot(slotUid);
}

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
    bumpRiskCheckVersion();
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

function hidePickMarker(): void {
  if (!mapInstance || !pickMarker) return;
  mapInstance.remove(pickMarker);
  pickMarker = null;
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

function centerToPlace(payload: PlacePayload, zoom = 14, showPickMarker = true): void {
  if (!mapInstance) return;
  mapInstance.setZoomAndCenter(zoom, [payload.longitude, payload.latitude]);
  if (showPickMarker) {
    updatePickMarker(payload);
    return;
  }
  hidePickMarker();
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
      locatePlace(place);
    });
    placeMarkerMap.set(place.id, marker);
  }
  applyMapScopeSelection(mapScopeSelection.value);
}

type MapPickPayload = {
  longitude: number;
  latitude: number;
  name: string;
  address: string;
  source: "hotspot" | "map";
};

async function onMapPicked(pick: MapPickPayload): Promise<void> {
  const hadEditingPlace = editingPlaceId.value !== null;
  if (hadEditingPlace) {
    editingPlaceId.value = null;
    placeTip.value = "已取消当前已选地点，可直接加入新地点";
  }
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

function setPlaceDraft(place: PlacePayload, showPickMarker = true): void {
  placeDraft.name = place.name;
  placeDraft.address = place.address;
  placeDraft.longitude = place.longitude;
  placeDraft.latitude = place.latitude;
  centerToPlace(placeDraft, 14, showPickMarker);
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
  }, false);
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
    const validIds = new Set(inPlan.map((item) => item.id));
    for (const slot of itinerarySlots.value) {
      slot.placeIds = slot.placeIds.filter((placeId) => validIds.has(placeId));
    }
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
    bumpRiskCheckVersion();
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
    await loadItinerary();
    bumpRiskCheckVersion();
    placeTip.value = "地点已删除";
  } catch (e) {
    placeError.value = e instanceof Error ? e.message : "删除地点失败";
  }
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
    placeTip.value = "已自动选中搜索结果第一个地点";
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

type PlaceJoinInfo = {
  joined: boolean;
  text: string;
  dayOrder: number;
  slotOrder: number;
  placeOrder: number;
};

function slotPlanningOrder(a: ItineraryDraftSlot, b: ItineraryDraftSlot): number {
  if (a.startMinute !== null && b.startMinute !== null) {
    if (a.startMinute !== b.startMinute) return a.startMinute - b.startMinute;
    if (a.endMinute !== null && b.endMinute !== null && a.endMinute !== b.endMinute) return a.endMinute - b.endMinute;
  }
  return 0;
}

const placeJoinInfoMap = computed(() => {
  const map = new Map<number, PlaceJoinInfo>();
  for (let day = 1; day <= planDays.value; day += 1) {
    const daySlots = itinerarySlots.value
      .filter((slot) => slot.dayIndex === day)
      .sort(slotPlanningOrder);
    daySlots.forEach((slot, slotOrder) => {
      slot.placeIds.forEach((placeId, placeOrder) => {
        if (map.has(placeId)) return;
        map.set(placeId, {
          joined: true,
          text: `已加入（${dayDateText(day)} ${slot.label}）`,
          dayOrder: day,
          slotOrder,
          placeOrder,
        });
      });
    });
  }
  return map;
});

function placeJoinText(placeId: number): string {
  return placeJoinInfoMap.value.get(placeId)?.text ?? "未加入时段规划";
}

const sortedPlanPlaces = computed(() => {
  const orderMap = new Map<number, number>();
  planPlaces.value.forEach((place, index) => orderMap.set(place.id, index));
  return [...planPlaces.value].sort((a, b) => {
    const infoA = placeJoinInfoMap.value.get(a.id);
    const infoB = placeJoinInfoMap.value.get(b.id);
    const joinedA = infoA?.joined ?? false;
    const joinedB = infoB?.joined ?? false;
    if (joinedA !== joinedB) return joinedA ? -1 : 1;
    if (joinedA && joinedB) {
      if (infoA!.dayOrder !== infoB!.dayOrder) return infoA!.dayOrder - infoB!.dayOrder;
      if (infoA!.slotOrder !== infoB!.slotOrder) return infoA!.slotOrder - infoB!.slotOrder;
      if (infoA!.placeOrder !== infoB!.placeOrder) return infoA!.placeOrder - infoB!.placeOrder;
    }
    return (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0);
  });
});

function showPlanPlacesOnMap(): void {
  if (!mapInstance || planPlaces.value.length === 0) return;
  applyMapScopeSelection("plan");
  const overlays = planPlaces.value
    .map((place) => placeMarkerMap.get(place.id))
    .filter((v): v is AMapMarkerLike => Boolean(v));
  if (overlays.length > 0) mapInstance.setFitView(overlays);
}

function showAllPlacesOnMap(): void {
  if (!mapInstance || placeMarkerMap.size === 0) return;
  applyMapScopeSelection("all");
  mapInstance.setFitView([...placeMarkerMap.values()]);
}

function clearMapScopeSelection(): void {
  applyMapScopeSelection(null);
}

function applyMapScopeSelection(scope: "plan" | "all" | null): void {
  mapScopeSelection.value = scope;
  if (!mapInstance) return;
  if (placeMarkerMap.size > 0) {
    mapInstance.remove([...placeMarkerMap.values()]);
  }
  if (scope === "all") {
    mapInstance.add([...placeMarkerMap.values()]);
    return;
  }
  if (scope === "plan") {
    const planMarkers = planPlaces.value
      .map((place) => placeMarkerMap.get(place.id))
      .filter((v): v is AMapMarkerLike => Boolean(v));
    if (planMarkers.length > 0) {
      mapInstance.add(planMarkers);
    }
  }
}

function onDocumentClickForMapScope(event: MouseEvent): void {
  if (mapScopeSelection.value === null) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest("[data-map-scope-button='true']")) return;
  clearMapScopeSelection();
}

function locatePlace(place: Place): void {
  applyMapScopeSelection("plan");
  setPlaceDraft({
    name: place.name,
    address: place.address,
    longitude: place.longitude,
    latitude: place.latitude,
  }, false);
  ensureMapCenteredInViewport();
}

function showAllHistoryPlacesOnMap(): void {
  showAllPlacesOnMap();
  ensureMapCenteredInViewport();
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

watch(selectedDay, (day) => {
  if (day < 1) {
    selectedDay.value = 1;
    return;
  }
  if (day > planDays.value) {
    selectedDay.value = planDays.value;
    return;
  }
  ensureDaySlots(day);
});

onMounted(async () => {
  await loadPlan();
  if (loadError.value) return;
  await nextTick();
  await initMap();
  await loadPlaces();
  await loadItinerary();
  document.addEventListener("click", onDocumentClickForMapScope, true);
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
  document.removeEventListener("click", onDocumentClickForMapScope, true);
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
      <div class="page-grid">
        <div class="weather-column">
          <WeatherSidebar
            :plan-id="planId"
            :risk-reload-key="riskCheckVersion"
            :longitude="placeDraft.longitude"
            :latitude="placeDraft.latitude"
            :place-name="placeDraft.name || placeDraft.address || '未命名地点'"
            :plan-date="draft.date"
            :all-places-count="allPlaces.length"
            @request-show-all-places="showAllHistoryPlacesOnMap"
          />
        </div>

        <div class="content-column">
          <section class="card plan-card">
            <div class="meta">
              <span v-if="planId !== null">规划 ID：{{ planId }}</span>
              <span>创建时间：{{ formatDateTime(createdAt) }}</span>
              <span>更新时间：{{ formatDateTime(updatedAt) }}</span>
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
                <button
                  type="button"
                  class="btn"
                  :class="{ active: mapScopeSelection === 'plan' }"
                  data-map-scope-button="true"
                  :disabled="planPlaces.length === 0"
                  @click="showPlanPlacesOnMap"
                >
                  显示当前规划全部地点
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
              </div>
            </form>

            <p v-if="placeLoading" class="muted">地点列表加载中...</p>
            <p v-if="placeError" class="error">{{ placeError }}</p>
            <p v-if="placeTip" class="tip">{{ placeTip }}</p>

            <section class="sub-card itinerary-card">
              <div class="section-title-row">
                <h3>时段行程</h3>
                <div class="section-actions">
                  <label class="day-count">
                    规划天数
                    <select :value="planDays" @change="setPlanDays(Number(($event.target as HTMLSelectElement).value))">
                      <option v-for="day in 30" :key="`days-${day}`" :value="day">{{ day }} 天</option>
                    </select>
                  </label>
                  <label class="day-count">
                    当前天
                    <select v-model.number="selectedDay">
                      <option v-for="day in planDays" :key="`selected-day-${day}`" :value="day">
                        第 {{ day }} 天（{{ dayDateText(day) }}）
                      </option>
                    </select>
                  </label>
                  <button type="button" class="btn small" @click="addItinerarySlot">新增时段</button>
                  <button type="button" class="btn small primary" :disabled="itinerarySaving" @click="saveItinerary">
                    {{ itinerarySaving ? "保存中..." : "保存时段行程" }}
                  </button>
                </div>
              </div>
              <p v-if="itineraryLoading" class="muted">时段行程加载中...</p>
              <p v-if="itineraryError" class="error">{{ itineraryError }}</p>
              <p v-if="itineraryTip" class="tip">{{ itineraryTip }}</p>
              <p v-if="currentDaySlots.length === 0" class="muted">当前天暂无时段，请新增后保存。</p>
              <ul v-else class="itinerary-list">
                <li v-for="(slot, index) in currentDaySlots" :key="slot.uid" class="itinerary-item">
                  <div class="itinerary-head">
                    <button type="button" class="itinerary-main" @click="focusSlotOnMap(slot)">
                      <strong>{{ slotTimeDisplay(slot) }}</strong>
                      <span>地点 {{ slot.placeIds.length }} 个（点击聚焦地图）</span>
                    </button>
                    <div class="item-actions">
                      <button
                        type="button"
                        class="btn small"
                        :disabled="index === 0"
                        @click="moveSlot(slot.uid, -1)"
                      >
                        上移
                      </button>
                      <button
                        type="button"
                        class="btn small"
                        :disabled="index === currentDaySlots.length - 1"
                        @click="moveSlot(slot.uid, 1)"
                      >
                        下移
                      </button>
                      <button
                        type="button"
                        class="btn small danger"
                        :disabled="currentDaySlots.length <= 1"
                        @click="removeItinerarySlot(slot.uid)"
                      >
                        删除时段
                      </button>
                    </div>
                  </div>

                  <div class="itinerary-editor">
                    <div class="grid">
                      <label>
                        时段名称
                        <input v-model.trim="slot.label" type="text" maxlength="30" :disabled="itinerarySaving" />
                      </label>
                      <label>
                        开始时间
                        <input
                          :value="minuteToTimeText(slot.startMinute)"
                          type="time"
                          :disabled="itinerarySaving"
                          @input="slot.startMinute = timeTextToMinute(String(($event.target as HTMLInputElement).value))"
                        />
                      </label>
                      <label>
                        结束时间
                        <input
                          :value="minuteToTimeText(slot.endMinute)"
                          type="time"
                          :disabled="itinerarySaving"
                          @input="slot.endMinute = timeTextToMinute(String(($event.target as HTMLInputElement).value))"
                        />
                      </label>
                    </div>

                    <div class="assign-row">
                      <select v-model="itinerarySlotPicker[slot.uid]" :disabled="planPlaces.length === 0">
                        <option :value="null">使用当前地图选中地点（未加入会自动加入）</option>
                        <option v-for="place in planPlaces" :key="`picker-${slot.uid}-${place.id}`" :value="place.id">
                          {{ place.name }}
                        </option>
                      </select>
                      <button type="button" class="btn small" @click="assignPlaceToSlot(slot.uid)">
                        分配地点
                      </button>
                    </div>

                    <div v-if="slot.placeIds.length > 0" class="tag-list">
                      <span v-for="placeId in slot.placeIds" :key="`slot-place-${slot.uid}-${placeId}`" class="tag">
                        {{ findPlaceInPlan(placeId)?.name || `地点 #${placeId}` }}
                        <button type="button" class="tag-remove" @click="removePlaceFromSlot(slot.uid, placeId)">x</button>
                      </span>
                    </div>
                    <p v-else class="muted">当前时段未分配地点。</p>

                    <div class="note-block">
                      <button type="button" class="btn small" @click="slot.noteExpanded = !slot.noteExpanded">
                        {{ slot.noteExpanded ? "收起备注" : "展开备注" }}
                      </button>
                      <textarea
                        v-if="slot.noteExpanded"
                        v-model.trim="slot.note"
                        rows="3"
                        maxlength="500"
                        placeholder="输入时段备注，可后续修改或清空"
                      />
                    </div>
                  </div>
                </li>
              </ul>
            </section>

            <div class="lists">
              <section class="sub-card plan-places-card">
                <h3>当前规划地点（{{ planPlaces.length }}）</h3>
                <p v-if="planPlaces.length === 0" class="muted">当前规划还没有地点，可在地图点击或搜索后加入。</p>
                <ul v-else class="place-list">
                  <li v-for="place in sortedPlanPlaces" :key="place.id" class="place-item">
                    <button type="button" class="place-main" @click="locatePlace(place)">
                      <strong>{{ place.name }}</strong>
                      <span>{{ place.address }}</span>
                      <span class="place-status">{{ placeJoinText(place.id) }}</span>
                    </button>
                    <div class="item-actions">
                      <button type="button" class="btn small" @click="startEditPlace(place)">编辑</button>
                      <button type="button" class="btn small danger" @click="removePlace(place.id)">删除</button>
                    </div>
                  </li>
                </ul>
              </section>
            </div>
          </section>
        </div>

        <aside class="ai-column">
          <AiSummaryPanel :plan-id="planId" :plan-title="draft.title" />
        </aside>
      </div>
    </template>
  </main>
</template>

<style scoped>
.container {
  max-width: 1640px;
  margin: 32px auto;
  padding: 0 16px 24px;
}
.page-grid {
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr) 360px;
  gap: 14px;
  align-items: stretch;
  height: calc(100vh - 120px);
}
.weather-column {
  position: sticky;
  top: 12px;
  align-self: start;
}
.content-column {
  min-width: 0;
  min-height: 0;
  max-height: 100%;
  overflow-y: auto;
  padding-right: 4px;
}
.ai-column {
  min-height: 0;
  max-height: 100%;
  overflow-y: auto;
  padding-right: 4px;
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
  background: #f8fbff;
  margin-bottom: 12px;
}
.plan-card {
  background: #f6faff;
}
.map-card {
  display: grid;
  gap: 12px;
  background: #f3f8ff;
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
.day-count {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #374151;
  font-size: 12px;
}
.day-count select {
  border: 1px solid #d1d5db;
  border-radius: 6px;
  padding: 4px 6px;
  font: inherit;
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
  background: #edf5ff;
}
.plan-places-card {
  background: #e8f2ff;
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
.place-status {
  color: #6b7280;
  font-size: 12px;
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
.btn.active {
  border-color: #2563eb;
  color: #1d4ed8;
}
.itinerary-card {
  background: #f8fafc;
}
.itinerary-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 8px;
}
.itinerary-item {
  border: 1px solid #dbeafe;
  border-radius: 8px;
  background: #fff;
  padding: 8px;
  display: grid;
  gap: 8px;
}
.itinerary-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
}
.itinerary-main {
  border: none;
  background: transparent;
  text-align: left;
  display: grid;
  gap: 4px;
  cursor: pointer;
  color: #111827;
}
.itinerary-main span {
  color: #6b7280;
  font-size: 12px;
}
.itinerary-editor {
  display: grid;
  gap: 8px;
}
.assign-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.assign-row select {
  min-width: 220px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  padding: 6px 8px;
  font: inherit;
}
.tag-list {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid #c7d2fe;
  border-radius: 999px;
  background: #eef2ff;
  padding: 2px 10px;
  font-size: 12px;
}
.tag-remove {
  border: none;
  background: transparent;
  color: #6b7280;
  cursor: pointer;
  padding: 0;
}
.note-block {
  display: grid;
  gap: 6px;
}
.note-block textarea {
  border: 1px solid #d1d5db;
  border-radius: 8px;
  padding: 8px;
  font: inherit;
  resize: vertical;
}
@media (max-width: 1080px) {
  .page-grid {
    grid-template-columns: 1fr;
    height: auto;
  }
  .weather-column {
    position: static;
  }
  .content-column {
    max-height: none;
    overflow: visible;
    padding-right: 0;
  }
  .ai-column {
    max-height: none;
    overflow: visible;
    padding-right: 0;
  }
}
</style>
