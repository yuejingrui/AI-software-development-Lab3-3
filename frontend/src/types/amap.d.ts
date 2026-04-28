export type AMapMapLike = {
  setZoomAndCenter: (zoom: number, center: [number, number]) => void;
  setFitView: (overlays?: unknown[]) => void;
  add: (overlays: unknown | unknown[]) => void;
  remove: (overlays: unknown | unknown[]) => void;
  on: (name: string, cb: (event: any) => void) => void;
  destroy: () => void;
};

export type AMapMarkerLike = {
  setPosition: (position: [number, number]) => void;
  setLabel?: (label: { content: string; direction?: string }) => void;
  setMap?: (map: AMapMapLike | null) => void;
  on?: (name: string, cb: () => void) => void;
};

export type AMapGlobal = {
  Map: new (container: string | HTMLElement, options: Record<string, unknown>) => AMapMapLike;
  Marker: new (options: Record<string, unknown>) => AMapMarkerLike;
  Polyline: new (options: Record<string, unknown>) => unknown;
  Text: new (options: Record<string, unknown>) => unknown;
  Pixel: new (x: number, y: number) => unknown;
};

declare global {
  interface Window {
    AMap?: AMapGlobal;
    _AMapSecurityConfig?: {
      securityJsCode: string;
    };
  }
}

export {};
