import { getNonDeletedElements } from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";

/** Longest side of the card thumbnail, in px (S1). */
export const THUMBNAIL_SIZE = 320;

/**
 * PNG preview of a scene, or null for an empty board (nothing to show).
 * The export code is loaded lazily: it is only needed after a save.
 */
export const renderThumbnail = async (scene: {
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
}): Promise<Blob | null> => {
  const elements = getNonDeletedElements(scene.elements);
  if (elements.length === 0) {
    return null;
  }
  const { exportToBlob } = await import("@excalidraw/utils/export");
  return exportToBlob({
    elements,
    appState: {
      viewBackgroundColor: scene.appState.viewBackgroundColor,
      // thumbnails always render light with their own background, whatever
      // the editor theme is, so every card looks consistent
      exportBackground: true,
      exportWithDarkMode: false,
      exportScale: 1,
    },
    files: scene.files,
    maxWidthOrHeight: THUMBNAIL_SIZE,
    exportPadding: 12,
    mimeType: "image/png",
  });
};
