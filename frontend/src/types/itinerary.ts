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
