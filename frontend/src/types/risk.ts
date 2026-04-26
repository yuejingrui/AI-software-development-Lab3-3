export type BudgetRisk = {
  level: "budget_ample" | "budget_tight" | "budget_over" | string;
  suggestion: string;
  estimated_total: number;
  budget: number;
  ratio: number;
  people_count: number;
  priced_places: number;
  missing_cost_places: number;
};

export type WeatherRisk = {
  has_forecast_for_plan_date: boolean;
  has_rain_or_snow: boolean;
  suggestion: string;
  matched_weather: string | null;
};

export type PlanRiskCheck = {
  budget_risk: BudgetRisk;
  weather_risk: WeatherRisk;
};
