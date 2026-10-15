import {
  cleanAppStateForExport,
  getDefaultAppState,
} from "@excalidraw/excalidraw/appState";

import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";
import type { AppState, BinaryFileData } from "@excalidraw/excalidraw/types";

import { appJotaiStore } from "../app-jotai";

import {
  boardsStatusAtom,
  flushBoardView,
  getBoardFiles,
  hasUnsavedBoardChanges,
  importFromBoardsServer,
  persistBoard,
} from "./boardPersistence";
import * as api from "./boardsApi";
import { BoardsApiError, BoardsUnreachableError } from "./boardsApi";

vi.mock("./boardsApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./boardsApi")>()),
  checkHealth: vi.fn(),
  listBoards: vi.fn(),
  createBoard: vi.fn(),
  getBoard: vi.fn(),
  saveBoard: vi.fn(),
}));

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
  vi.mocked(api.listBoards).mockResolvedValue([
    { ...meta("t1"), hasThumbnail: false },
  ]);
  vi.mocked(api.saveBoard).mockReset();
  vi.mocked(api.createBoard).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("loading", () => {
  it("opens the most recently modified board", async () => {
    await loadBoard();
    expect(api.getBoard).toHaveBeenCalledWith("board-1");
    expect(api.createBoard).not.toHaveBeenCalled();
    expect(status()).toEqual({ kind: "ok" });
  });

  it("creates the first board when the folder is empty", async () => {
    vi.mocked(api.listBoards).mockResolvedValue([]);
    vi.mocked(api.createBoard).mockResolvedValue(meta("t0"));
    await loadBoard();
    expect(api.createBoard).toHaveBeenCalledTimes(1);
    expect(api.getBoard).toHaveBeenCalledWith("board-1");
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
    expect(status().kind).toBe("load-failed");
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
