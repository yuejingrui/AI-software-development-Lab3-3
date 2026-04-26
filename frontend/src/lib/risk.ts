import { apiGet } from "./api";
import type { PlanRiskCheck } from "../types/risk";

export async function fetchPlanRiskCheck(planId: number): Promise<PlanRiskCheck> {
  return apiGet<PlanRiskCheck>(`/plans/${planId}/risk-check`);
}
