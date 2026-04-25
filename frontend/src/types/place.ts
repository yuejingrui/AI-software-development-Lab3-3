export type Place = {
  id: number;
  plan_id: number;
  plan_title?: string | null;
  name: string;
  address: string;
  longitude: number;
  latitude: number;
  created_at: string;
  updated_at: string;
};

export type PlacePayload = {
  name: string;
  address: string;
  longitude: number;
  latitude: number;
};
