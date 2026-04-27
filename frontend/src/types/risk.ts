export type WeatherRisk = {
  has_forecast_for_plan_date: boolean;
  has_rain_or_snow: boolean;
  suggestion: string;
  matched_weather: string | null;
};

export type PlanRiskCheck = {
  weather_risk: WeatherRisk;
};
