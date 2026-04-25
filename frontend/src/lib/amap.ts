import type { AMapGlobal } from "../types/amap";
import { apiGet } from "./api";

type SearchCandidate = {
  name: string;
  address: string;
  longitude: number;
  latitude: number;
};

let sdkPromise: Promise<AMapGlobal> | null = null;
let mapConfigPromise: Promise<{ js_key: string; security_js_code: string }> | null = null;

async function loadMapConfig(): Promise<{ js_key: string; security_js_code: string }> {
  if (!mapConfigPromise) {
    mapConfigPromise = apiGet<{ js_key: string; security_js_code: string }>("/map/config");
  }
  return mapConfigPromise;
}

export async function assertAmapKeyReady(): Promise<string | null> {
  try {
    await loadMapConfig();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "地图配置加载失败";
  }
}

export async function loadAmapSdk(): Promise<AMapGlobal> {
  if (window.AMap) return window.AMap;
  if (sdkPromise) return sdkPromise;
  const config = await loadMapConfig();

  sdkPromise = new Promise<AMapGlobal>((resolve, reject) => {
    window._AMapSecurityConfig = { securityJsCode: config.security_js_code };
    const script = document.createElement("script");
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(config.js_key)}`;
    script.async = true;
    script.onerror = () => reject(new Error("加载高德地图 SDK 失败"));
    script.onload = () => {
      if (!window.AMap) {
        reject(new Error("高德地图 SDK 初始化失败"));
        return;
      }
      resolve(window.AMap);
    };
    document.head.appendChild(script);
  });

  return sdkPromise;
}

export async function searchPoi(keyword: string): Promise<SearchCandidate[]> {
  const qs = new URLSearchParams({ keywords: keyword.trim() });
  return apiGet<SearchCandidate[]>(`/map/search?${qs.toString()}`);
}

export async function reverseGeocode(longitude: number, latitude: number): Promise<string> {
  const qs = new URLSearchParams({
    longitude: String(longitude),
    latitude: String(latitude),
  });
  return apiGet<string>(`/map/reverse-geocode?${qs.toString()}`);
}
