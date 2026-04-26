export type WeatherCurrent = {
  province: string;
  city: string;
  district: string;
  adcode: string;
  weather: string;
  temperature_c: number;
  wind_direction: string;
  wind_speed_mps: number;
  report_time: string;
};

export type WeatherForecastDay = {
  date: string;
  weather: string;
  high_temp_c: number;
  low_temp_c: number;
};

export type WeatherByLocation = {
  province: string;
  city: string;
  district: string;
  adcode: string;
  current: WeatherCurrent;
  forecast: WeatherForecastDay[];
};
