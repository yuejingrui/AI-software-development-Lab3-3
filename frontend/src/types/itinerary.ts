export type ItinerarySlotPlace = {
  slot_place_id: number;
  sort_index: number;
  place_id: number;
  name: string;
  address: string;
  longitude: number;
  latitude: number;
};

export type ItinerarySlot = {
  id: number;
  plan_id: number;
  day_index: number;
  label: string;
  start_minute: number | null;
  end_minute: number | null;
  sort_index: number;
  note: string;
  places: ItinerarySlotPlace[];
};

export type ItinerarySlotPayload = {
  id?: number;
  day_index: number;
  label: string;
  start_minute: number | null;
  end_minute: number | null;
  sort_index: number;
  note: string;
  place_ids: number[];
};

export type ItineraryUpdatePayload = {
  slots: ItinerarySlotPayload[];
};

export type ItineraryRoutePoint = {
  place_id: number;
  name: string;
  address: string;
  longitude: number;
  latitude: number;
  day_index: number;
  slot_id: number;
  slot_label: string;
  slot_order: number;
  place_order: number;
};

export type ItineraryRouteLeg = {
  from_place_id: number;
  to_place_id: number;
  preferred_mode: "walk" | "drive" | "transit";
  distance_m: number;
  display_text: string;
  walking_duration_s: number | null;
  driving_duration_s: number | null;
  transit_duration_s: number | null;
};

export type ItineraryRouteData = {
  day_index: number;
  places: ItineraryRoutePoint[];
  legs: ItineraryRouteLeg[];
};
