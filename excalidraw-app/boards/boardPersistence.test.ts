import {
  cleanAppStateForExport,
  getDefaultAppState,
} from "@excalidraw/excalidraw/appState";
import { loadFromBlob } from "@excalidraw/excalidraw/data/blob";

import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";
import type { AppState, BinaryFileData } from "@excalidraw/excalidraw/types";

import { appJotaiStore } from "../app-jotai";

import {
  boardsStatusAtom,
  closeBoardSession,
  discardUnsavedBoardEdits,
  flushBoardThumbnail,
  flushBoardView,
  getBoardFiles,
  getSaveGeneration,
  hasUnsavedBoardChanges,
  importFromBoardsServer,
  persistBoard,
  saveLatestAsNewBoard,
  settleBoardSaves,
} from "./boardPersistence";
import * as api from "./boardsApi";
import { BoardsApiError, BoardsUnreachableError } from "./boardsApi";
import { activeBoardAtom, boardRouteAtom } from "./boardsRoute";
import { renderThumbnail } from "./thumbnail";

vi.mock("./boardsApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./boardsApi")>()),
  checkHealth: vi.fn(),
  listBoards: vi.fn(),
  createBoard: vi.fn(),
  getBoard: vi.fn(),
  saveBoard: vi.fn(),
  putThumbnail: vi.fn(),
}));

vi.mock("./thumbnail", () => ({ renderThumbnail: vi.fn() }));

const FILE = {
  id: "f1",
  mimeType: "image/png",
  dataURL: "data:image/png;base64,AAAA",
  created: 1,
} as unknown as BinaryFileData;

const baseAppState = {
  ...getDefaultAppState(),
  width: 800,
  height: 600,
  offsetTop: 0,
  offsetLeft: 0,
} as AppState;

const meta = (updatedAt: string, extra: object = {}) => ({
  id: "board-1",
  name: "Tablero 1",
  createdAt: "t0",
  updatedAt,
  elementCount: 1,
  ...extra,
});

const element = (version: number) =>
  ({
    id: "a",
    type: "rectangle",
    version,
    isDeleted: false,
  } as unknown as ExcalidrawElement);

// serializeAsJSON only keeps files that an image element points to
const imageElement = {
  id: "img",
  type: "image",
  fileId: "f1",
  version: 1,
  isDeleted: false,
  status: "saved",
} as unknown as ExcalidrawElement;

/** What the editor hands to LocalData.save. */
const snap = (version: number, appState: Partial<AppState> = {}) => ({
  elements: [element(version), imageElement],
  appState: { ...baseAppState, ...appState },
  files: { f1: FILE } as Record<string, BinaryFileData>,
});

const status = () => appJotaiStore.get(boardsStatusAtom);

const sentBody = (call: number) =>
  JSON.parse(vi.mocked(api.saveBoard).mock.calls[call][1]);

const loadBoard = async (viewState?: api.BoardViewState) => {
  vi.mocked(api.getBoard).mockResolvedValue({
    meta: meta("t1", viewState && { viewState }),
    scene: {
      type: "excalidraw",
      version: 2,
      source: "test",
      elements: [element(1), imageElement],
      // already "on disk" exactly as the editor would export it
      appState: cleanAppStateForExport(baseAppState),
      files: { f1: FILE },
    },
  });
  return importFromBoardsServer();
};

beforeEach(() => {
  vi.mocked(api.checkHealth).mockResolvedValue({ ok: true, dir: "/data" });
  vi.mocked(api.saveBoard).mockReset();
  vi.mocked(api.putThumbnail).mockReset().mockResolvedValue(null);
  vi.mocked(renderThumbnail).mockReset().mockResolvedValue(null);
  appJotaiStore.set(boardRouteAtom, { status: "board", boardId: "board-1" });
});

afterEach(() => {
  closeBoardSession(); // also cancels any pending thumbnail timer
  vi.useRealTimers();
});

describe("loading", () => {
  it("opens the board named by the route and exposes its name", async () => {
    await loadBoard();
    expect(api.getBoard).toHaveBeenCalledWith("board-1");
    expect(status()).toEqual({ kind: "ok" });
    expect(appJotaiStore.get(activeBoardAtom)).toEqual({
      id: "board-1",
      name: "Tablero 1",
    });
  });

  it("opens whichever board the route points at, not a fixed one", async () => {
    appJotaiStore.set(boardRouteAtom, { status: "board", boardId: "board-2" });
    await loadBoard();
    expect(api.getBoard).toHaveBeenLastCalledWith("board-2");
  });

  it("refuses to load (and to save) when no board is selected", async () => {
    appJotaiStore.set(boardRouteAtom, { status: "home" });
    const { elements } = await importFromBoardsServer();
    expect(elements).toEqual([]);
    expect(status()).toMatchObject({ kind: "load-failed", unreachable: false });
    expect(appJotaiStore.get(activeBoardAtom)).toBeNull();
    expect(await persistBoard(snap(2))).toBe(false);
  });

  it("tells 'board does not exist' apart from 'server down'", async () => {
    vi.mocked(api.getBoard).mockRejectedValue(
      new BoardsApiError(404, "not_found", "Board x does not exist."),
    );
    const { appState } = await importFromBoardsServer();
    expect(status()).toMatchObject({ kind: "load-failed", unreachable: false });
    expect(appState?.errorMessage).toMatch(/no se guardará/);
    expect(appState?.errorMessage).toMatch(/dirección/); // not "start the server"
    expect(appState?.errorMessage).not.toMatch(/Inicia el servidor/);
    expect(await persistBoard(snap(2))).toBe(false);
    expect(api.saveBoard).not.toHaveBeenCalled();
  });

  it("restores the saved camera and serves the embedded images", async () => {
    const { appState } = await loadBoard({ scrollX: 5, scrollY: 6, zoom: 2 });
    expect(appState).toMatchObject({ scrollX: 5, scrollY: 6 });
    expect(appState?.zoom?.value).toBe(2);

    const files = getBoardFiles(["f1" as FileId, "missing" as FileId]);
    expect(files?.loadedFiles).toEqual([FILE]);
    expect([...files!.erroredFiles.keys()]).toEqual(["missing"]);
  });

  it("never writes when the board could not be loaded", async () => {
    vi.mocked(api.checkHealth).mockRejectedValue(
      new BoardsUnreachableError("HTTP 500"),
    );
    const { elements, appState } = await importFromBoardsServer();

    // an empty scene + an error dialog, NOT something that can be autosaved
    expect(elements).toEqual([]);
    expect(appState?.errorMessage).toMatch(/no se guardará/);
    expect(appState?.errorMessage).toMatch(/yarn start:boards/);
    expect(status()).toMatchObject({ kind: "load-failed", unreachable: true });
    expect(getBoardFiles(["f1" as FileId])).toBeNull();

    expect(await persistBoard(snap(5))).toBe(false);
    flushBoardView();
    expect(api.saveBoard).not.toHaveBeenCalled();
  });
});

describe("saving", () => {
  it("does not rewrite what it just loaded", async () => {
    await loadBoard();
    expect(await persistBoard(snap(1))).toBe(true);
    expect(api.saveBoard).not.toHaveBeenCalled();
    expect(hasUnsavedBoardChanges()).toBe(false);
  });

  it("saves a change with the current token, then advances the token", async () => {
    await loadBoard();
    vi.mocked(api.saveBoard)
      .mockResolvedValueOnce(meta("t2"))
      .mockResolvedValueOnce(meta("t3"));

    expect(await persistBoard(snap(2))).toBe(true);
    expect(await persistBoard(snap(3))).toBe(true);

    expect(api.saveBoard).toHaveBeenCalledTimes(2);
    expect(sentBody(0).baseUpdatedAt).toBe("t1");
    expect(sentBody(1).baseUpdatedAt).toBe("t2");
    // same document "Save to disk" produces, images embedded
    expect(sentBody(0).scene).toMatchObject({
      type: "excalidraw",
      elements: [
        { id: "a", version: 2 },
        { id: "img", fileId: "f1" },
      ],
      files: { f1: { dataURL: FILE.dataURL } },
    });
    expect(sentBody(0).viewState).toEqual({ scrollX: 0, scrollY: 0, zoom: 1 });
  });

  it("keeps scrolling from rewriting the file; only a flush saves the camera", async () => {
    await loadBoard();
    vi.mocked(api.saveBoard).mockResolvedValue(meta("t2"));

    expect(await persistBoard(snap(1, { scrollX: 300 }))).toBe(true);
    expect(api.saveBoard).not.toHaveBeenCalled();

    flushBoardView();
    await vi.waitFor(() => expect(api.saveBoard).toHaveBeenCalledTimes(1));
    expect(sentBody(0).viewState.scrollX).toBe(300);
  });

  it("sends one request at a time, always with the newest scene", async () => {
    await loadBoard();
    let finishFirst!: (m: ReturnType<typeof meta>) => void;
    vi.mocked(api.saveBoard)
      .mockImplementationOnce(
        () => new Promise((resolve) => (finishFirst = resolve)),
      )
      .mockResolvedValueOnce(meta("t3"));

    const first = persistBoard(snap(2));
    const second = persistBoard(snap(3));
    expect(api.saveBoard).toHaveBeenCalledTimes(1); // 2nd must wait

    finishFirst(meta("t2"));
    const [firstSaved, secondSaved] = await Promise.all([first, second]);

    expect(api.saveBoard).toHaveBeenCalledTimes(2);
    expect(sentBody(1).baseUpdatedAt).toBe("t2"); // no stale token -> no false 409
    expect(sentBody(1).scene.elements[0].version).toBe(3);
    // the superseded snapshot isn't what is on disk; the newest one is
    expect(firstSaved).toBe(false);
    expect(secondSaved).toBe(true);
  });
});

describe("failures", () => {
  it("keeps the work in memory, warns, and retries until the server is back", async () => {
    await loadBoard();
    vi.useFakeTimers();
    vi.mocked(api.saveBoard)
      .mockRejectedValueOnce(new BoardsUnreachableError("HTTP 500"))
      .mockResolvedValueOnce(meta("t2"));

    expect(await persistBoard(snap(2))).toBe(false);
    expect(status()).toEqual({ kind: "offline" });
    expect(hasUnsavedBoardChanges()).toBe(true);

    await vi.advanceTimersByTimeAsync(3000);

    expect(api.saveBoard).toHaveBeenCalledTimes(2);
    expect(sentBody(1).scene.elements[0].version).toBe(2); // same unsaved work
    expect(status()).toEqual({ kind: "ok" });
    expect(hasUnsavedBoardChanges()).toBe(false);
  });

  it("stops instead of overwriting when another tab saved first (409)", async () => {
    await loadBoard();
    vi.mocked(api.saveBoard).mockRejectedValue(
      new BoardsApiError(409, "conflict", "changed on disk"),
    );

    expect(await persistBoard(snap(2))).toBe(false);
    expect(status()).toEqual({ kind: "conflict" });

    expect(await persistBoard(snap(3))).toBe(false);
    flushBoardView();
    expect(api.saveBoard).toHaveBeenCalledTimes(1); // no further attempts
    // unsaved edits remain, so leaving the page must warn
    expect(hasUnsavedBoardChanges()).toBe(true);
  });

  it("reports a rejected save (e.g. too large) without retry loops", async () => {
    await loadBoard();
    vi.useFakeTimers();
    vi.mocked(api.saveBoard).mockRejectedValue(
      new BoardsApiError(413, "payload_too_large", "Body exceeds limit"),
    );

    expect(await persistBoard(snap(2))).toBe(false);
    expect(status()).toMatchObject({ kind: "rejected" });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.saveBoard).toHaveBeenCalledTimes(1);
  });
});

describe("switching boards", () => {
  it("drops a save made under the previous board's generation", async () => {
    await loadBoard();
    const madeUnderBoardA = getSaveGeneration();

    appJotaiStore.set(boardRouteAtom, { status: "board", boardId: "board-2" });
    await loadBoard(); // board B is now loaded

    // a debounced save from board A fires late: it must NOT touch board B
    expect(await persistBoard(snap(9), madeUnderBoardA)).toBe(false);
    flushBoardView();
    expect(api.saveBoard).not.toHaveBeenCalled();
    expect(hasUnsavedBoardChanges()).toBe(false);
  });

  it("still accepts saves made under the current generation", async () => {
    await loadBoard();
    vi.mocked(api.saveBoard).mockResolvedValue(meta("t2"));
    expect(await persistBoard(snap(2), getSaveGeneration())).toBe(true);
    expect(api.saveBoard).toHaveBeenCalledTimes(1);
  });

  it("settleBoardSaves waits for the in-flight save and reports success", async () => {
    await loadBoard();
    let finish!: (m: ReturnType<typeof meta>) => void;
    vi.mocked(api.saveBoard).mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)),
    );

    const saving = persistBoard(snap(2));
    let settled = false;
    const waiting = settleBoardSaves().then((ok) => {
      settled = true;
      return ok;
    });

    await Promise.resolve();
    expect(settled).toBe(false); // still waiting for the server

    finish(meta("t2"));
    await saving;
    expect(await waiting).toBe(true);
  });

  it("settleBoardSaves reports failure when edits could not be saved", async () => {
    await loadBoard();
    vi.useFakeTimers();
    vi.mocked(api.saveBoard).mockRejectedValue(
      new BoardsUnreachableError("HTTP 500"),
    );
    await persistBoard(snap(2));
    expect(await settleBoardSaves()).toBe(false);
  });

  it("settleBoardSaves is true when there is nothing to save", async () => {
    await loadBoard();
    expect(await settleBoardSaves()).toBe(true);
  });
});

describe("editor preferences", () => {
  const PREFS_KEY = "excalidraw-boards-prefs";

  beforeEach(() => {
    localStorage.removeItem(PREFS_KEY);
  });

  it("applies the stored stroke/fill preferences to any board that is opened", async () => {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ currentItemStrokeColor: "#e03131" }),
    );
    const { appState } = await loadBoard();
    expect(appState?.currentItemStrokeColor).toBe("#e03131");
  });

  it("lets the board's own saved appState win over preferences", async () => {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ viewBackgroundColor: "#000" }),
    );
    const { appState } = await loadBoard();
    expect(appState?.viewBackgroundColor).toBe(
      baseAppState.viewBackgroundColor,
    );
  });

  it("stores only currentItem* preferences, once per change, in its own key", async () => {
    await loadBoard();
    vi.mocked(api.saveBoard).mockResolvedValue(meta("t2"));
    // the repo's test setup polyfills localStorage, so spy on the object itself
    const setItem = vi.spyOn(localStorage, "setItem");

    await persistBoard(snap(1, { currentItemStrokeColor: "#2f9e44" }));
    await persistBoard(snap(1, { currentItemStrokeColor: "#2f9e44" }));
    await persistBoard(snap(1, { currentItemStrokeColor: "#1971c2" }));

    const writes = setItem.mock.calls.filter(([key]) => key === PREFS_KEY);
    expect(writes).toHaveLength(2); // unchanged value isn't rewritten
    const stored = JSON.parse(localStorage.getItem(PREFS_KEY)!);
    expect(stored.currentItemStrokeColor).toBe("#1971c2");
    expect(Object.keys(stored).every((k) => k.startsWith("currentItem"))).toBe(
      true,
    );
    // the browser's original scene keys stay untouched
    expect(setItem.mock.calls.map(([key]) => key)).not.toContain("excalidraw");
    expect(setItem.mock.calls.map(([key]) => key)).not.toContain(
      "excalidraw-state",
    );
    setItem.mockRestore();
  });

  it("does not store preferences when no board is loaded", async () => {
    vi.mocked(api.checkHealth).mockRejectedValue(
      new BoardsUnreachableError("HTTP 500"),
    );
    await importFromBoardsServer();
    await persistBoard(snap(1, { currentItemStrokeColor: "#f08c00" }));
    expect(localStorage.getItem(PREFS_KEY)).toBeNull();
  });
});

describe("thumbnails", () => {
  const PNG = new Blob(["png"], { type: "image/png" });

  const saveOnce = async () => {
    await loadBoard();
    vi.mocked(api.saveBoard).mockResolvedValue(meta("t2"));
    vi.mocked(renderThumbnail).mockResolvedValue(PNG);
    expect(await persistBoard(snap(2))).toBe(true);
  };

  it("refreshes the thumbnail a few seconds after a save, not on every stroke", async () => {
    vi.useFakeTimers();
    await saveOnce();
    expect(renderThumbnail).not.toHaveBeenCalled(); // throttled

    await vi.advanceTimersByTimeAsync(8000);
    expect(renderThumbnail).toHaveBeenCalledTimes(1);
    expect(api.putThumbnail).toHaveBeenCalledWith("board-1", PNG);
  });

  it("coalesces several saves into one thumbnail of the latest scene", async () => {
    vi.useFakeTimers();
    await saveOnce();
    vi.mocked(api.saveBoard).mockResolvedValue(meta("t3"));
    await persistBoard(snap(3));
    await vi.advanceTimersByTimeAsync(8000);

    expect(renderThumbnail).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(renderThumbnail).mock.calls[0][0].elements[0].version,
    ).toBe(3);
  });

  it("flushBoardThumbnail renders it right away (used when leaving a board)", async () => {
    vi.useFakeTimers();
    await saveOnce();
    await flushBoardThumbnail();
    expect(api.putThumbnail).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000); // the timer was cancelled
    expect(api.putThumbnail).toHaveBeenCalledTimes(1);
  });

  it("does not regenerate it for a camera-only change", async () => {
    vi.useFakeTimers();
    await loadBoard();
    vi.mocked(api.saveBoard).mockResolvedValue(meta("t2"));
    await persistBoard(snap(1, { scrollX: 500 }));
    flushBoardView();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.saveBoard).toHaveBeenCalledTimes(1); // camera saved...
    expect(renderThumbnail).not.toHaveBeenCalled(); // ...thumbnail untouched
  });

  it("skips empty boards (nothing to draw)", async () => {
    await saveOnce();
    vi.mocked(renderThumbnail).mockResolvedValue(null);
    await flushBoardThumbnail();
    expect(api.putThumbnail).not.toHaveBeenCalled();
  });

  it("never lets a thumbnail failure affect saving", async () => {
    await saveOnce();
    vi.mocked(api.putThumbnail).mockRejectedValue(
      new BoardsUnreachableError("HTTP 500"),
    );
    await expect(flushBoardThumbnail()).resolves.toBeUndefined();
    expect(status()).toEqual({ kind: "ok" });
    expect(hasUnsavedBoardChanges()).toBe(false);
  });

  it("drops a pending thumbnail when the session is closed", async () => {
    vi.useFakeTimers();
    await saveOnce();
    closeBoardSession();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(renderThumbnail).not.toHaveBeenCalled();
  });
});

describe("conflict way out", () => {
  const conflict = async () => {
    await loadBoard();
    vi.mocked(api.saveBoard).mockRejectedValue(
      new BoardsApiError(409, "conflict", "changed on disk"),
    );
    await persistBoard(snap(5)); // this tab's work, refused by the server
    expect(status()).toEqual({ kind: "conflict" });
  };

  it("keeps this tab's work as a new board, images included", async () => {
    await conflict();
    vi.mocked(api.createBoard).mockResolvedValue(meta("t9", { id: "copy" }));

    await saveLatestAsNewBoard();

    const [name, scene] = vi.mocked(api.createBoard).mock.calls[0] as [
      string,
      any,
    ];
    expect(name).toBe("Tablero 1 (copia de conflicto)");
    expect(scene).toMatchObject({
      type: "excalidraw",
      elements: [{ id: "a", version: 5 }, { id: "img" }],
      files: { f1: { dataURL: FILE.dataURL } },
    });
  });

  it("stops warning about unsaved edits once they were kept elsewhere", async () => {
    await conflict();
    expect(hasUnsavedBoardChanges()).toBe(true); // would warn on leaving
    discardUnsavedBoardEdits();
    expect(hasUnsavedBoardChanges()).toBe(false);
    expect(await settleBoardSaves()).toBe(true); // switching may proceed
  });

  it("refuses to make a copy when there is nothing to save", async () => {
    await loadBoard();
    await expect(saveLatestAsNewBoard()).rejects.toThrow();
  });
});

describe("file format", () => {
  // jsdom has no Blob#text() (every real browser does); test-only stand-in
  beforeAll(() => {
    if (!Blob.prototype.text) {
      Blob.prototype.text = function text(this: Blob) {
        return new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsText(this);
        });
      };
    }
  });

  it("is a standard .excalidraw file: the editor's own Open can load it (as excalidraw.com does)", async () => {
    await loadBoard();
    vi.mocked(api.saveBoard).mockResolvedValue(meta("t2"));
    await persistBoard(snap(2));

    // exactly what the server stores for this board (it keeps the scene as is)
    const stored = JSON.stringify(sentBody(0).scene);
    const opened = await loadFromBlob(
      new Blob([stored], { type: "application/json" }),
      null,
      null,
    );

    expect(opened.elements.map((el) => el.id).sort()).toEqual(["a", "img"]);
    expect(opened.files["f1" as FileId]?.dataURL).toBe(FILE.dataURL);
    expect(JSON.parse(stored)).toMatchObject({
      type: "excalidraw",
      version: 2,
    });
  });
});
