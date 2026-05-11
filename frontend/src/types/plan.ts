export type Plan = {
  id: number;
  title: string;
  date: string;
  budget: number;
  people_count: number;
  preferences: string;
  pinned: number;
  created_at: string;
  updated_at: string;
};

export type PlanPayload = {
  title: string;
  date: string;
  budget: number;
  people_count: number;
  preferences: string;
};
