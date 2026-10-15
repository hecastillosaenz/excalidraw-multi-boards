/**
 * Disk persistence for the active board. `LocalData` delegates here instead of
 * writing to localStorage / IndexedDB, which are tied to the browser origin
 * (protocol + host + port). The source of truth is the file behind
 * boards-server, so changing the dev-server port no longer loses anything.
 *
 * Rules this module enforces:
 * - never writes anywhere unless a board was loaded (a failed load must not
 *   turn into an empty scene that overwrites the real board);
 * - one request in flight at a time, always carrying the newest scene;
 * - if the server is unreachable the scene stays in memory and saving retries;
 * - on a 409 (another tab saved) saving stops instead of overwriting.
 */

import { isTestEnv } from "@excalidraw/common";
import { getNonDeletedElements, getSceneVersion } from "@excalidraw/element";
import { cleanAppStateForExport } from "@excalidraw/excalidraw/appState";
import { serializeAsJSON } from "@excalidraw/excalidraw/data/json";

import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
} from "@excalidraw/excalidraw/types";

import { appJotaiStore, atom } from "../app-jotai";

import {
  BoardsApiError,
  BoardsUnreachableError,
  checkHealth,
  getBoard,
  saveBoard,
} from "./boardsApi";
import { activeBoardAtom, getActiveBoardId } from "./boardsRoute";

import type { BoardViewState } from "./boardsApi";

/**
 * Single switch so the original local persistence stays intact in the code.
 * Off under test so upstream's own app tests (which mount the whole editor
 * with no boards-server) keep exercising the original code path.
 */
export const BOARDS_PERSISTENCE_ENABLED = !isTestEnv();

/** Debounce for disk saves (N3: >= 1 s; upstream's local one is 300 ms). */
export const BOARDS_SAVE_TIMEOUT = 1000;

// Editor preferences (stroke colour, width, font...) are not board content and
// the standard .excalidraw format doesn't keep them. They live in a NEW
// localStorage key so they follow you across boards; the original keys of
// the browser are never touched.
const PREFS_KEY = "excalidraw-boards-prefs";

const RETRY_MIN_MS = 3000;
const RETRY_MAX_MS = 30000;
// fetch `keepalive` bodies are capped (~64 KB) by browsers
const KEEPALIVE_MAX_CHARS = 60_000;

const LOAD_FAILED_UNREACHABLE_MESSAGE =
  "No se pudo cargar el tablero desde el servidor de tableros. " +
  "Este lienzo vacío NO es tu tablero y no se guardará nada en él. " +
  "Inicia el servidor y recarga la página.";

const LOAD_FAILED_OTHER_MESSAGE =
  "No se pudo abrir este tablero. " +
  "Este lienzo vacío NO es tu tablero y no se guardará nada en él. " +
  "Revisa la dirección (?board=) y recarga la página.";

export type BoardsStatus =
  | { kind: "ok" }
  | { kind: "load-failed"; detail: string; unreachable: boolean }
  | { kind: "offline" }
  | { kind: "conflict" }
  | { kind: "rejected"; detail: string };

export const boardsStatusAtom = atom<BoardsStatus>({ kind: "ok" });

type Snapshot = {
  elements: readonly ExcalidrawElement[];
  appState: AppState;
  files: BinaryFiles;
};

type Session = {
  id: string;
  /** `updatedAt` of the last version we know the server has (the 409 token). */
  token: string;
  /** Images embedded in the board file, served to the editor on load. */
  files: Map<FileId, BinaryFileData>;
  conflict: boolean;
};

let session: Session | null = null;
/**
 * Bumped whenever the loaded board changes. Every save request carries the
 * generation it was made under, so a debounced save left over from board A can
 * never be written into board B after a switch.
 */
let generation = 0;
let latest: Snapshot | null = null;
let savedSignature: string | null = null;
let savedViewSignature: string | null = null;

let running: Promise<void> | null = null;
let wantsRun = false;
let wantsForce = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = RETRY_MIN_MS;

const pickPrefs = (appState: Partial<AppState>) =>
  Object.fromEntries(
    Object.entries(appState).filter(([key]) => key.startsWith("currentItem")),
  ) as Partial<AppState>;

const loadPrefs = (): Partial<AppState> => {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
  } catch {
    return {};
  }
};

let savedPrefs: string | null = null;

const savePrefs = (appState: Partial<AppState>) => {
  const json = JSON.stringify(pickPrefs(appState));
  if (json === savedPrefs) {
    return;
  }
  try {
    localStorage.setItem(PREFS_KEY, json);
    savedPrefs = json;
  } catch {
    // preferences are a nicety: never let them break saving
  }
};

const setStatus = (next: BoardsStatus) => {
  const current = appJotaiStore.get(boardsStatusAtom);
  if (JSON.stringify(current) !== JSON.stringify(next)) {
    appJotaiStore.set(boardsStatusAtom, next);
  }
};

const resetState = () => {
  generation++;
  session = null;
  appJotaiStore.set(activeBoardAtom, null);
  latest = null;
  savedSignature = null;
  savedViewSignature = null;
  savedPrefs = null;
  wantsRun = false;
  wantsForce = false;
  retryDelay = RETRY_MIN_MS;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
};

/**
 * Cheap fingerprint of what ends up in the board file. Camera movement is
 * deliberately NOT part of it, so scrolling doesn't rewrite the whole file.
 */
const sceneSignature = (
  elements: readonly ExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
) =>
  [
    getSceneVersion(elements),
    elements.length,
    Object.keys(files).length,
    JSON.stringify(cleanAppStateForExport(appState)),
  ].join("|");

const viewStateOf = (appState: Partial<AppState>): BoardViewState => ({
  scrollX: appState.scrollX ?? 0,
  scrollY: appState.scrollY ?? 0,
  zoom: appState.zoom?.value ?? 1,
});

/**
 * Called instead of `importFromLocalStorage()` when the editor starts. Never
 * throws: on failure it returns an empty scene carrying an error dialog and
 * leaves persistence disabled, so nothing can overwrite the real board.
 */
export const importFromBoardsServer = async (): Promise<{
  elements: ExcalidrawElement[];
  appState: Partial<AppState> | null;
}> => {
  resetState();
  try {
    await checkHealth();
    const id = getActiveBoardId();
    if (!id) {
      throw new Error("No hay ningún tablero seleccionado.");
    }
    const { meta, scene } = await getBoard(id);

    const files = scene.files ?? {};
    appJotaiStore.set(activeBoardAtom, { id, name: meta.name });
    session = {
      id,
      token: meta.updatedAt,
      files: new Map(Object.entries(files)) as Map<FileId, BinaryFileData>,
      conflict: false,
    };
    // what we just loaded is, by definition, already on disk
    savedSignature = sceneSignature(
      scene.elements,
      scene.appState ?? {},
      files,
    );
    if (meta.viewState) {
      savedViewSignature = JSON.stringify(meta.viewState);
    }
    setStatus({ kind: "ok" });

    return {
      elements: scene.elements,
      appState: {
        ...loadPrefs(),
        ...scene.appState,
        ...(meta.viewState && {
          scrollX: meta.viewState.scrollX,
          scrollY: meta.viewState.scrollY,
          zoom: { value: meta.viewState.zoom } as AppState["zoom"],
        }),
      },
    };
  } catch (error) {
    session = null;
    console.error("[boards] could not load the board:", error);
    const unreachable = error instanceof BoardsUnreachableError;
    setStatus({
      kind: "load-failed",
      detail: error instanceof Error ? error.message : String(error),
      unreachable,
    });
    return {
      elements: [],
      appState: {
        errorMessage: unreachable
          ? LOAD_FAILED_UNREACHABLE_MESSAGE
          : LOAD_FAILED_OTHER_MESSAGE,
      },
    };
  }
};

export const hasBoardSession = () => session !== null;

/** Images of the loaded board, in the shape `FileManager.getFiles` expects. */
export const getBoardFiles = (ids: FileId[]) => {
  if (!session) {
    return null;
  }
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();
  for (const id of ids) {
    const file = session.files.get(id);
    if (file) {
      loadedFiles.push(file);
    } else {
      erroredFiles.set(id, true);
    }
  }
  return { loadedFiles, erroredFiles };
};

const scheduleRetry = () => {
  if (retryTimer) {
    return;
  }
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void run(true);
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
};

const handleSaveError = (error: unknown, current: Session) => {
  if (error instanceof BoardsApiError && error.status === 409) {
    current.conflict = true;
    setStatus({ kind: "conflict" });
    return;
  }
  const transient =
    error instanceof BoardsUnreachableError ||
    (error instanceof BoardsApiError && error.status >= 500);
  if (transient) {
    setStatus({ kind: "offline" });
    scheduleRetry();
    return;
  }
  // e.g. 413 too large / 400: retrying the same payload can't help. The next
  // edit makes a fresh attempt.
  console.error("[boards] save rejected:", error);
  setStatus({
    kind: "rejected",
    detail: error instanceof Error ? error.message : String(error),
  });
};

/** Writes the newest snapshot if needed. Never throws. */
const writeLatest = async (force: boolean) => {
  const current = session;
  const snapshot = latest;
  if (!current || !snapshot || current.conflict) {
    return;
  }

  const signature = sceneSignature(
    snapshot.elements,
    snapshot.appState,
    snapshot.files,
  );
  const viewState = JSON.stringify(viewStateOf(snapshot.appState));
  const sceneChanged = signature !== savedSignature;
  const viewChanged = viewState !== savedViewSignature;
  // a camera-only change is saved on flush (blur / hidden / unload), not on
  // every pause while scrolling
  if (!sceneChanged && !(force && viewChanged)) {
    return;
  }

  const scene = serializeAsJSON(
    getNonDeletedElements(snapshot.elements),
    snapshot.appState,
    snapshot.files,
    "local",
  );
  const body = `{"scene":${scene},"baseUpdatedAt":${JSON.stringify(
    current.token,
  )},"viewState":${viewState}}`;

  try {
    const meta = await saveBoard(
      current.id,
      body,
      body.length < KEEPALIVE_MAX_CHARS,
    );
    if (session !== current) {
      return;
    }
    current.token = meta.updatedAt;
    savedSignature = signature;
    savedViewSignature = viewState;
    retryDelay = RETRY_MIN_MS;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    setStatus({ kind: "ok" });
  } catch (error) {
    if (session === current) {
      handleSaveError(error, current);
    }
  }
};

/**
 * Single-flight: while a request is in flight further requests only mark
 * "run again", so overlapping saves can't trip the 409 check with a stale
 * token, and the follow-up always carries the newest scene.
 */
const run = (force: boolean) => {
  wantsRun = true;
  wantsForce ||= force;
  running ??= (async () => {
    try {
      while (wantsRun) {
        wantsRun = false;
        const forced = wantsForce;
        wantsForce = false;
        await writeLatest(forced);
      }
    } finally {
      running = null;
    }
  })();
  return running;
};

/**
 * Debounced save path (`LocalData._save`).
 * @returns whether this snapshot is now on disk; only then may the caller mark
 * images as saved.
 */
export const persistBoard = async (
  snapshot: Snapshot,
  /** generation read when the change was made (see `getSaveGeneration`) */
  madeUnder: number = generation,
) => {
  if (!session || madeUnder !== generation) {
    return false;
  }
  savePrefs(snapshot.appState);
  latest = snapshot;
  await run(false);
  return (
    savedSignature ===
    sceneSignature(snapshot.elements, snapshot.appState, snapshot.files)
  );
};

/** Flush path: also persists a camera-only change (blur / hidden / unload). */
export const flushBoardView = () => {
  if (session && latest) {
    void run(true);
  }
};

export const getSaveGeneration = () => generation;

/**
 * Waits until no request is in flight.
 * @returns whether the open board then has no unsaved scene edits.
 */
export const settleBoardSaves = async () => {
  while (running) {
    await running;
  }
  return !hasUnsavedBoardChanges();
};

/** Scene edits not yet confirmed on disk (drives the "leave site?" prompt). */
export const hasUnsavedBoardChanges = () =>
  session !== null &&
  latest !== null &&
  sceneSignature(latest.elements, latest.appState, latest.files) !==
    savedSignature;
