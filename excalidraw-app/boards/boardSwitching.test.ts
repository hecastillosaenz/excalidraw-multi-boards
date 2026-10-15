import { appJotaiStore } from "../app-jotai";
import { LocalData } from "../data/LocalData";

import * as persistence from "./boardPersistence";
import {
  createAndOpenBoard,
  saveBoardBeforeLeaving,
  switchToBoard,
} from "./boardSwitching";
import * as api from "./boardsApi";
import {
  boardRouteAtom,
  boardSwitchingAtom,
  getActiveBoardId,
  readBoardIdFromUrl,
  resolveDefaultBoardId,
} from "./boardsRoute";

import type * as RouteModule from "./boardsRoute";

vi.mock("../data/LocalData", () => ({
  LocalData: { flushSave: vi.fn(), fileStorage: { reset: vi.fn() } },
}));
vi.mock("./boardPersistence", () => ({
  settleBoardSaves: vi.fn(),
}));
vi.mock("./boardsApi", () => ({
  listBoards: vi.fn(),
  createBoard: vi.fn(),
}));

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const openAt = (id: string) => {
  window.history.replaceState(null, "", `/?board=${id}`);
  appJotaiStore.set(boardRouteAtom, { status: "ready", boardId: id });
};

beforeEach(() => {
  vi.clearAllMocks();
  openAt(A);
  vi.mocked(persistence.settleBoardSaves).mockResolvedValue(true);
});

describe("route", () => {
  it("reads a valid ?board= and ignores junk", () => {
    window.history.replaceState(null, "", `/?board=${B}&x=1#hash`);
    expect(readBoardIdFromUrl()).toBe(B);
    window.history.replaceState(null, "", "/?board=../../etc/passwd");
    expect(readBoardIdFromUrl()).toBeNull();
    window.history.replaceState(null, "", "/");
    expect(readBoardIdFromUrl()).toBeNull();
  });

  it("keeps other params and the hash when switching", async () => {
    window.history.replaceState(null, "", `/?board=${A}&keep=1#frag`);
    await switchToBoard(B);
    expect(window.location.search).toBe(`?board=${B}&keep=1`);
    expect(window.location.hash).toBe("#frag");
  });

  it("picks the most recent board when none is given, creating one only if empty", async () => {
    vi.mocked(api.listBoards).mockResolvedValue([
      { id: B } as Awaited<ReturnType<typeof api.listBoards>>[number],
    ]);
    expect(await resolveDefaultBoardId()).toBe(B);
    expect(api.createBoard).not.toHaveBeenCalled();
  });

  it("does not create two boards when asked twice (StrictMode double effect)", async () => {
    vi.resetModules();
    const fresh = (await import("./boardsRoute")) as typeof RouteModule;
    const freshApi = await import("./boardsApi");
    vi.mocked(freshApi.listBoards).mockResolvedValue([]);
    vi.mocked(freshApi.createBoard).mockResolvedValue({ id: A } as Awaited<
      ReturnType<typeof freshApi.createBoard>
    >);
    const [first, second] = await Promise.all([
      fresh.resolveDefaultBoardId(),
      fresh.resolveDefaultBoardId(),
    ]);
    expect([first, second]).toEqual([A, A]);
    expect(freshApi.createBoard).toHaveBeenCalledTimes(1);
  });
});

describe("switching", () => {
  it("saves and waits BEFORE moving to the other board", async () => {
    const order: string[] = [];
    vi.mocked(LocalData.flushSave).mockImplementation(() => {
      order.push("flush");
    });
    vi.mocked(persistence.settleBoardSaves).mockImplementation(async () => {
      order.push("settled");
      return true;
    });
    vi.mocked(LocalData.fileStorage.reset).mockImplementation(() => {
      order.push("reset-files");
    });
    const unsubscribe = appJotaiStore.sub(boardRouteAtom, () => {
      order.push(`route:${getActiveBoardId()}`);
    });

    await switchToBoard(B);
    unsubscribe();

    expect(order).toEqual(["flush", "settled", "reset-files", `route:${B}`]);
    expect(window.location.search).toBe(`?board=${B}`);
  });

  it("raises the input-blocking veil only while it works", async () => {
    const seen: boolean[] = [];
    const unsubscribe = appJotaiStore.sub(boardSwitchingAtom, () => {
      seen.push(appJotaiStore.get(boardSwitchingAtom));
    });
    await switchToBoard(B);
    unsubscribe();
    expect(seen).toEqual([true, false]);
  });

  it("does nothing when asked for the board that is already open", async () => {
    await switchToBoard(A);
    expect(LocalData.flushSave).not.toHaveBeenCalled();
  });

  it("stays on the board if saving fails and the user declines to lose changes", async () => {
    vi.mocked(persistence.settleBoardSaves).mockResolvedValue(false);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    await switchToBoard(B);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(LocalData.flushSave).toHaveBeenCalledTimes(3); // retried first
    expect(getActiveBoardId()).toBe(A);
    expect(window.location.search).toBe(`?board=${A}`);
    expect(LocalData.fileStorage.reset).not.toHaveBeenCalled();
    expect(appJotaiStore.get(boardSwitchingAtom)).toBe(false);
  });

  it("switches anyway only if the user explicitly accepts losing the changes", async () => {
    vi.mocked(persistence.settleBoardSaves).mockResolvedValue(false);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await switchToBoard(B);
    expect(getActiveBoardId()).toBe(B);
  });

  it("saveBoardBeforeLeaving succeeds as soon as a save settles", async () => {
    vi.mocked(persistence.settleBoardSaves)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    expect(await saveBoardBeforeLeaving()).toBe(true);
    expect(LocalData.flushSave).toHaveBeenCalledTimes(2);
  });

  it("creates a board only after the current one is saved, then opens it", async () => {
    vi.mocked(api.createBoard).mockResolvedValue({ id: B } as Awaited<
      ReturnType<typeof api.createBoard>
    >);
    await createAndOpenBoard();
    expect(LocalData.flushSave).toHaveBeenCalled();
    expect(getActiveBoardId()).toBe(B);
  });

  it("does not create a board nor leave if the current one can't be saved", async () => {
    vi.mocked(persistence.settleBoardSaves).mockResolvedValue(false);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await createAndOpenBoard();
    expect(api.createBoard).not.toHaveBeenCalled();
    expect(getActiveBoardId()).toBe(A);
  });
});
