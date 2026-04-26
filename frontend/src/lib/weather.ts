import { apiGet } from "./api";
import type { WeatherByLocation } from "../types/weather";

export async function fetchWeatherByLocation(longitude: number, latitude: number): Promise<WeatherByLocation> {
  const qs = new URLSearchParams({
    longitude: String(longitude),
    latitude: String(latitude),
  });
  return apiGet<WeatherByLocation>(`/weather/by-location?${qs.toString()}`);
}
