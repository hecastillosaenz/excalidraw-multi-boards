/** Per-board camera, kept in the sidecar because exported appState drops it. */
export type ViewState = { scrollX: number; scrollY: number; zoom: number };

export type BoardMeta = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  elementCount: number;
  viewState?: ViewState;
};

export type BoardListItem = Omit<BoardMeta, "viewState"> & {
  hasThumbnail: boolean;
};

/** Native `.excalidraw` document (same shape as "Save to disk"). */
export type Scene = {
  type: "excalidraw";
  version: number;
  source: string;
  elements: unknown[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
};
