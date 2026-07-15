// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { setBadge } from "@/app/store/badge";
import { getFileSubject } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import {
    fetchWaveFile,
    getApi,
    getOverrideConfigAtom,
    getSettingsKeyAtom,
    globalStore,
    isDev,
    openLink,
    WOS,
} from "@/store/global";
import * as services from "@/store/services";
import { PLATFORM, PlatformMacOS } from "@/util/platformutil";
import { base64ToArray, fireAndForget } from "@/util/util";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import * as TermTypes from "@xterm/xterm";
import { Terminal } from "@xterm/xterm";
import debug from "debug";
import * as jotai from "jotai";
import { debounce } from "throttle-debounce";
import {
    handleOsc16162Command,
    handleOsc52Command,
    handleOsc7Command,
    isClaudeCodeCommand,
    type ShellIntegrationStatus,
} from "./osc-handlers";
import {
    bufferLinesToText,
    createTempFileFromBlob,
    extractAllClipboardData,
    normalizeCursorStyle,
    quoteForPosixShell,
    trimTerminalSelection,
} from "./termutil";

const dlog = debug("wave:termwrap");

const TermFileName = "term";
const TermCacheFileName = "cache:term:full";
const MinDataProcessedForCache = 100 * 1024;
export const SupportsImageInput = true;
const MaxRepaintTransactionMs = 2000;
const TouchGestureCommitThresholdPx = 10;
const TouchScrollDominanceRatio = 1.5;
const TouchLongPressMs = 500;
const TouchLongPressMoveTolerancePx = 10;

// detect webgl support
function detectWebGLSupport(): boolean {
    try {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("webgl2");
        return !!ctx;
    } catch (e) {
        return false;
    }
}

export const WebGLSupported = detectWebGLSupport();
let loggedWebGL = false;

type TermWrapOptions = {
    keydownHandler?: (e: KeyboardEvent) => boolean;
    useWebGl?: boolean;
    sendDataHandler?: (data: string) => void;
    nodeModel?: BlockNodeModel;
};

export class TermWrap {
    tabId: string;
    blockId: string;
    ptyOffset: number;
    dataBytesProcessed: number;
    terminal: Terminal;
    connectElem: HTMLDivElement;
    fitAddon: FitAddon;
    searchAddon: SearchAddon;
    serializeAddon: SerializeAddon;
    mainFileSubject: SubjectWithRef<WSFileEventData>;
    loaded: boolean;
    heldData: Uint8Array[];
    handleResize_debounced: () => void;
    hasResized: boolean;
    multiInputCallback: (data: string) => void;
    sendDataHandler: (data: string) => void;
    onSearchResultsDidChange?: (result: { resultIndex: number; resultCount: number }) => void;
    toDispose: TermTypes.IDisposable[] = [];
    webglAddon: WebglAddon | null = null;
    webglContextLossDisposable: TermTypes.IDisposable | null = null;
    webglEnabledAtom: jotai.PrimitiveAtom<boolean>;
    pasteActive: boolean = false;
    lastUpdated: number;
    promptMarkers: TermTypes.IMarker[] = [];
    shellIntegrationStatusAtom: jotai.PrimitiveAtom<ShellIntegrationStatus | null>;
    lastCommandAtom: jotai.PrimitiveAtom<string | null>;
    claudeCodeActiveAtom: jotai.PrimitiveAtom<boolean>;
    nodeModel: BlockNodeModel; // this can be null
    hoveredLinkUri: string | null = null;
    onLinkHover?: (uri: string | null, mouseX: number, mouseY: number) => void;

    // Paste deduplication
    // xterm.js paste() method triggers onData event, which can cause duplicate sends
    lastPasteData: string = "";
    lastPasteTime: number = 0;

    // dev only (for debugging)
    recentWrites: { idx: number; data: string; ts: number }[] = [];
    recentWritesCounter: number = 0;

    // for repaint transaction scrolling behavior
    lastClearScrollbackTs: number = 0;
    lastMode2026SetTs: number = 0;
    lastMode2026ResetTs: number = 0;
    inSyncTransaction: boolean = false;
    inRepaintTransaction: boolean = false;
    touchSelectGestureActive: boolean = false;
    private selectionHandlesUpdateListeners = new Set<() => void>();
    private selectionAdjustAnchor: { x: number; y: number } | null = null;
    private selectionAdjustHandle: "start" | "end" | null = null;

    constructor(
        tabId: string,
        blockId: string,
        connectElem: HTMLDivElement,
        options: TermTypes.ITerminalOptions & TermTypes.ITerminalInitOnlyOptions,
        waveOptions: TermWrapOptions
    ) {
        this.loaded = false;
        this.tabId = tabId;
        this.blockId = blockId;
        this.sendDataHandler = waveOptions.sendDataHandler;
        this.nodeModel = waveOptions.nodeModel;
        this.ptyOffset = 0;
        this.dataBytesProcessed = 0;
        this.hasResized = false;
        this.lastUpdated = Date.now();
        this.promptMarkers = [];
        this.shellIntegrationStatusAtom = jotai.atom(null) as jotai.PrimitiveAtom<ShellIntegrationStatus | null>;
        this.lastCommandAtom = jotai.atom(null) as jotai.PrimitiveAtom<string | null>;
        this.claudeCodeActiveAtom = jotai.atom(false);
        this.webglEnabledAtom = jotai.atom(false) as jotai.PrimitiveAtom<boolean>;
        this.terminal = new Terminal(options);
        this.fitAddon = new FitAddon();
        this.serializeAddon = new SerializeAddon();
        this.searchAddon = new SearchAddon();
        this.terminal.loadAddon(this.searchAddon);
        this.terminal.loadAddon(this.fitAddon);
        this.terminal.loadAddon(this.serializeAddon);
        this.terminal.loadAddon(
            new WebLinksAddon(
                (e, uri) => {
                    e.preventDefault();
                    switch (PLATFORM) {
                        case PlatformMacOS:
                            if (e.metaKey) {
                                fireAndForget(() => openLink(uri));
                            }
                            break;
                        default:
                            if (e.ctrlKey) {
                                fireAndForget(() => openLink(uri));
                            }
                            break;
                    }
                },
                {
                    hover: (e, uri) => {
                        this.hoveredLinkUri = uri;
                        this.onLinkHover?.(uri, e.clientX, e.clientY);
                    },
                    leave: () => {
                        this.hoveredLinkUri = null;
                        this.onLinkHover?.(null, 0, 0);
                    },
                }
            )
        );
        this.setTermRenderer(WebGLSupported && waveOptions.useWebGl ? "webgl" : "dom");
        // Register OSC handlers
        this.terminal.parser.registerOscHandler(7, (data: string) => {
            try {
                return handleOsc7Command(data, this.blockId, this.loaded);
            } catch (e) {
                console.error("[termwrap] osc 7 handler error", this.blockId, e);
                return false;
            }
        });
        this.terminal.parser.registerOscHandler(52, (data: string) => {
            try {
                return handleOsc52Command(data, this.blockId, this.loaded, this);
            } catch (e) {
                console.error("[termwrap] osc 52 handler error", this.blockId, e);
                return false;
            }
        });
        this.terminal.parser.registerOscHandler(16162, (data: string) => {
            try {
                return handleOsc16162Command(data, this.blockId, this.loaded, this);
            } catch (e) {
                console.error("[termwrap] osc 16162 handler error", this.blockId, e);
                return false;
            }
        });
        this.toDispose.push(
            this.terminal.parser.registerCsiHandler({ final: "J" }, (params) => {
                if (params == null || params.length < 1) {
                    return false;
                }
                if (params[0] === 3) {
                    this.lastClearScrollbackTs = Date.now();
                    if (this.inSyncTransaction) {
                        console.log("[termwrap] repaint transaction starting");
                        this.inRepaintTransaction = true;
                    }
                }
                return false;
            })
        );
        this.toDispose.push(
            this.terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
                if (params == null || params.length < 1) {
                    return false;
                }
                if (params[0] === 2026) {
                    this.lastMode2026SetTs = Date.now();
                    this.inSyncTransaction = true;
                }
                return false;
            })
        );
        this.toDispose.push(
            this.terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
                if (params == null || params.length < 1) {
                    return false;
                }
                if (params[0] === 2026) {
                    this.lastMode2026ResetTs = Date.now();
                    this.inSyncTransaction = false;
                    const wasRepaint = this.inRepaintTransaction;
                    this.inRepaintTransaction = false;
                    if (wasRepaint && Date.now() - this.lastClearScrollbackTs <= MaxRepaintTransactionMs) {
                        setTimeout(() => {
                            console.log("[termwrap] repaint transaction complete, scrolling to bottom");
                            this.terminal.scrollToBottom();
                        }, 20);
                    }
                }
                return false;
            })
        );
        this.toDispose.push(
            this.terminal.onBell(() => {
                if (!this.loaded) {
                    return true;
                }
                console.log("BEL received in terminal", this.blockId);
                const bellSoundEnabled =
                    globalStore.get(getOverrideConfigAtom(this.blockId, "term:bellsound")) ?? false;
                if (bellSoundEnabled) {
                    fireAndForget(() => RpcApi.ElectronSystemBellCommand(TabRpcClient, { route: "electron" }));
                }
                const bellIndicatorEnabled =
                    globalStore.get(getOverrideConfigAtom(this.blockId, "term:bellindicator")) ?? false;
                if (bellIndicatorEnabled) {
                    setBadge(this.blockId, { icon: "bell", color: "#fbbf24", priority: 1 });
                }
                return true;
            })
        );
        this.terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
            if (!waveOptions.keydownHandler) {
                return true;
            }
            return waveOptions.keydownHandler(e);
        });
        this.connectElem = connectElem;
        this.mainFileSubject = null;
        this.heldData = [];
        this.handleResize_debounced = debounce(50, this.handleResize.bind(this));
        this.terminal.open(this.connectElem);

        const dragoverHandler = (e: DragEvent) => {
            e.preventDefault();
            if (e.dataTransfer) {
                e.dataTransfer.dropEffect = "copy";
            }
        };
        const dropHandler = (e: DragEvent) => {
            e.preventDefault();
            if (!e.dataTransfer || e.dataTransfer.files.length === 0) {
                return;
            }
            const paths: string[] = [];
            for (let i = 0; i < e.dataTransfer.files.length; i++) {
                const file = e.dataTransfer.files[i];
                const filePath = getApi().getPathForFile(file);
                if (filePath) {
                    paths.push(quoteForPosixShell(filePath));
                }
            }
            if (paths.length > 0) {
                this.terminal.paste(paths.join(" ") + " ");
            }
        };
        this.connectElem.addEventListener("dragover", dragoverHandler);
        this.connectElem.addEventListener("drop", dropHandler);
        this.toDispose.push({
            dispose: () => {
                this.connectElem.removeEventListener("dragover", dragoverHandler);
                this.connectElem.removeEventListener("drop", dropHandler);
            },
        });
        this.handleResize();
        const pasteHandler = this.pasteHandler.bind(this);
        this.connectElem.addEventListener("paste", pasteHandler, true);
        this.toDispose.push({
            dispose: () => {
                this.connectElem.removeEventListener("paste", pasteHandler, true);
            },
        });

        let lastMiddleClickPasteTs = 0;
        const middleClickPasteHandler = (e: MouseEvent) => {
            if (e.button !== 1) {
                return;
            }
            if (!globalStore.get(getSettingsKeyAtom("term:pasteonmiddleclick"))) {
                return;
            }
            const now = Date.now();
            if (now - lastMiddleClickPasteTs < 100) {
                return;
            }
            lastMiddleClickPasteTs = now;
            e.preventDefault();
            e.stopPropagation();
            this.terminal.focus();
            setTimeout(() => {
                getApi().nativePaste();
            }, 0);
        };
        this.connectElem.addEventListener("mousedown", middleClickPasteHandler, true);
        this.toDispose.push({
            dispose: () => {
                this.connectElem.removeEventListener("mousedown", middleClickPasteHandler, true);
            },
        });
        this.toDispose.push(this.attachTouchInteractionHandler());
        this.toDispose.push(
            this.terminal.onScroll(() => {
                if (this.terminal.hasSelection()) {
                    this.notifySelectionHandlesUpdate();
                }
            })
        );
    }

    private isTouchScrollEnabled(): boolean {
        return globalStore.get(getOverrideConfigAtom(this.blockId, "term:touchscroll")) !== false;
    }

    private isTouchTextSelectEnabled(): boolean {
        return globalStore.get(getOverrideConfigAtom(this.blockId, "term:touchtextselect")) !== false;
    }

    private updateTouchTextSelectClass(): void {
        const enabled = this.isTouchTextSelectEnabled();
        this.connectElem.classList.toggle("term-touchtextselect-enabled", enabled);
        this.connectElem.classList.toggle("term-touchtextselect-disabled", !enabled);
    }

    private dispatchTerminalMouseEvent(
        type: "mousedown" | "mousemove" | "mouseup",
        clientX: number,
        clientY: number
    ): void {
        const termElem = this.terminal.element;
        if (termElem == null) {
            return;
        }
        termElem.dispatchEvent(
            new MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX,
                clientY,
                button: 0,
                buttons: type === "mouseup" ? 0 : 1,
            })
        );
    }

    isTouchSelectGestureActive(): boolean {
        return this.touchSelectGestureActive;
    }

    subscribeSelectionHandlesUpdate(listener: () => void): () => void {
        this.selectionHandlesUpdateListeners.add(listener);
        return () => {
            this.selectionHandlesUpdateListeners.delete(listener);
        };
    }

    private notifySelectionHandlesUpdate(): void {
        requestAnimationFrame(() => {
            for (const listener of this.selectionHandlesUpdateListeners) {
                listener();
            }
        });
    }

    getSelectionHandlePositions(): {
        start: { left: number; top: number };
        end: { left: number; top: number };
    } | null {
        if (!this.terminal.hasSelection()) {
            return null;
        }
        const selectionPos = this.terminal.getSelectionPosition();
        if (selectionPos == null) {
            return null;
        }
        const connectRect = this.connectElem.getBoundingClientRect();
        const selectionElem = this.terminal.element?.querySelector(".xterm-selection");
        const selectionDivs = selectionElem
            ? Array.from(selectionElem.querySelectorAll<HTMLElement>("div")).filter(
                  (div) => div.offsetWidth > 0 || div.offsetHeight > 0
              )
            : [];
        if (selectionDivs.length > 0) {
            const firstRect = selectionDivs[0].getBoundingClientRect();
            const lastRect = selectionDivs[selectionDivs.length - 1].getBoundingClientRect();
            const forward =
                selectionPos.start.y < selectionPos.end.y ||
                (selectionPos.start.y === selectionPos.end.y && selectionPos.start.x <= selectionPos.end.x);
            if (forward) {
                return {
                    start: {
                        left: firstRect.left - connectRect.left,
                        top: firstRect.bottom - connectRect.top,
                    },
                    end: { left: lastRect.right - connectRect.left, top: lastRect.bottom - connectRect.top },
                };
            }
            return {
                start: { left: lastRect.right - connectRect.left, top: lastRect.bottom - connectRect.top },
                end: { left: firstRect.left - connectRect.left, top: firstRect.bottom - connectRect.top },
            };
        }
        const startLeft = this.bufferCellToClientOffset(selectionPos.start, false);
        const startBottom = this.bufferCellToClientOffset(selectionPos.start, true);
        const endClient = this.bufferCellToClientOffset(selectionPos.end, true);
        return {
            start: {
                left: startLeft.x - connectRect.left,
                top: startBottom.y - connectRect.top,
            },
            end: { left: endClient.x - connectRect.left, top: endClient.y - connectRect.top },
        };
    }

    beginSelectionHandleAdjust(handle: "start" | "end"): void {
        const selectionPos = this.terminal.getSelectionPosition();
        if (selectionPos == null) {
            return;
        }
        this.selectionAdjustHandle = handle;
        this.touchSelectGestureActive = true;
        if (handle === "start") {
            this.selectionAdjustAnchor = { x: selectionPos.end.x, y: selectionPos.end.y };
            return;
        }
        this.selectionAdjustAnchor = { x: selectionPos.start.x, y: selectionPos.start.y };
    }

    updateSelectionHandleAdjust(clientX: number, clientY: number): void {
        if (this.selectionAdjustAnchor == null || this.selectionAdjustHandle == null) {
            return;
        }
        const movingCell = this.clientToBufferCell(clientX, clientY);
        if (movingCell == null) {
            return;
        }
        this.autoScrollWhileSelecting(clientY);
        const refreshedCell = this.clientToBufferCell(clientX, clientY);
        if (refreshedCell == null) {
            return;
        }
        if (this.selectionAdjustHandle === "start") {
            this.applySelectionRange(refreshedCell, this.selectionAdjustAnchor);
        } else {
            this.applySelectionRange(this.selectionAdjustAnchor, refreshedCell);
        }
        this.notifySelectionHandlesUpdate();
    }

    endSelectionHandleAdjust(clientX: number, clientY: number): void {
        this.updateSelectionHandleAdjust(clientX, clientY);
        this.selectionAdjustHandle = null;
        this.selectionAdjustAnchor = null;
        this.touchSelectGestureActive = false;
        this.notifySelectionHandlesUpdate();
    }

    private applySelectionRange(
        start: { x: number; y: number },
        end: { x: number; y: number }
    ): void {
        let rangeStart = start;
        let rangeEnd = end;
        if (
            rangeStart.y > rangeEnd.y ||
            (rangeStart.y === rangeEnd.y && rangeStart.x > rangeEnd.x)
        ) {
            rangeStart = end;
            rangeEnd = start;
        }
        const startCol = rangeStart.x - 1;
        const startRow = rangeStart.y - 1;
        const endCol = rangeEnd.x - 1;
        const endRow = rangeEnd.y - 1;
        const cols = this.terminal.cols;
        const length = (endRow - startRow) * cols + (endCol - startCol) + 1;
        if (length <= 0) {
            this.terminal.clearSelection();
            return;
        }
        this.terminal.select(startCol, startRow, length);
    }

    private clientToBufferCell(clientX: number, clientY: number): { x: number; y: number } | null {
        const screenElement = this.terminal.element?.querySelector(".xterm-screen") as HTMLElement | null;
        if (screenElement == null) {
            return null;
        }
        type XtermCore = {
            _mouseService?: {
                getCoords: (
                    event: MouseEvent,
                    element: HTMLElement,
                    cols: number,
                    rows: number,
                    isSelection?: boolean
                ) => [number, number] | undefined;
            };
        };
        const core = (this.terminal as unknown as { _core?: XtermCore })._core;
        const coords = core?._mouseService?.getCoords?.(
            { clientX, clientY } as MouseEvent,
            screenElement,
            this.terminal.cols,
            this.terminal.rows,
            true
        );
        if (coords != null) {
            const viewportY = this.terminal.buffer.active.viewportY;
            return { x: coords[0], y: viewportY + coords[1] };
        }
        const charWidth = this.getCharWidth();
        const lineHeight = this.getTouchScrollLineHeight();
        if (charWidth <= 0 || lineHeight <= 0) {
            return null;
        }
        const screenRect = screenElement.getBoundingClientRect();
        const rowsElem = this.terminal.element?.querySelector(".xterm-rows") as HTMLElement | null;
        const rowsTop = rowsElem?.getBoundingClientRect().top ?? screenRect.top;
        const col = Math.floor((clientX - screenRect.left) / charWidth) + 1;
        const rowInView = Math.floor((clientY - rowsTop) / lineHeight) + 1;
        const viewportY = this.terminal.buffer.active.viewportY;
        return {
            x: Math.min(Math.max(col, 1), this.terminal.cols),
            y: Math.min(Math.max(viewportY + rowInView, 1), this.terminal.buffer.active.length),
        };
    }

    private selectWordAtClient(clientX: number, clientY: number): boolean {
        const termElement = this.terminal.element;
        if (termElement != null) {
            termElement.dispatchEvent(
                new MouseEvent("dblclick", {
                    bubbles: true,
                    cancelable: true,
                    clientX,
                    clientY,
                    view: window,
                    detail: 2,
                })
            );
            if (this.terminal.hasSelection()) {
                return true;
            }
        }
        type SelectionService = {
            _selectWordAtCursor?: (event: MouseEvent, allowWhitespaceOnlyWord: boolean) => boolean;
            refresh?: (immediate?: boolean) => void;
            _fireEventIfSelectionChanged?: () => void;
        };
        type XtermCore = {
            _selectionService?: SelectionService;
        };
        const core = (this.terminal as unknown as { _core?: XtermCore })._core;
        const fakeEvent = { clientX, clientY, detail: 2 } as MouseEvent;
        if (core?._selectionService?._selectWordAtCursor?.(fakeEvent, false)) {
            core._selectionService.refresh?.(true);
            core._selectionService._fireEventIfSelectionChanged?.();
            return true;
        }
        const cell = this.clientToBufferCell(clientX, clientY);
        if (cell == null) {
            return false;
        }
        this.selectWordAtCell(cell);
        return this.terminal.hasSelection();
    }

    private selectWordAtCell(cell: { x: number; y: number }): void {
        const buffer = this.terminal.buffer.active;
        const line = buffer.getLine(cell.y - 1);
        if (line == null) {
            return;
        }
        const wordSeparators = this.terminal.options.wordSeparator ?? " ()[]{}',\"`";
        const isSeparator = (ch: string) => ch.length === 0 || wordSeparators.indexOf(ch) >= 0;
        const lineText = line.translateToString(true);
        let startCol = cell.x - 1;
        let endCol = cell.x - 1;
        while (startCol > 0 && !isSeparator(lineText[startCol - 1] ?? "")) {
            startCol--;
        }
        while (endCol < lineText.length - 1 && !isSeparator(lineText[endCol + 1] ?? "")) {
            endCol++;
        }
        this.applySelectionRange({ x: startCol + 1, y: cell.y }, { x: endCol + 1, y: cell.y });
    }

    private getSelectionExtendAnchor(
        touchCell: { x: number; y: number },
        selectionPos: { start: { x: number; y: number }; end: { x: number; y: number } }
    ): { x: number; y: number } {
        const distToStart =
            Math.abs(touchCell.x - selectionPos.start.x) + Math.abs(touchCell.y - selectionPos.start.y);
        const distToEnd = Math.abs(touchCell.x - selectionPos.end.x) + Math.abs(touchCell.y - selectionPos.end.y);
        return distToStart <= distToEnd ? selectionPos.end : selectionPos.start;
    }

    private extendTouchSelection(
        anchor: { x: number; y: number },
        clientX: number,
        clientY: number
    ): void {
        this.autoScrollWhileSelecting(clientY);
        const movingCell = this.clientToBufferCell(clientX, clientY);
        if (movingCell == null) {
            return;
        }
        this.applySelectionRange(anchor, movingCell);
    }

    private autoScrollWhileSelecting(clientY: number): void {
        const viewport = this.terminal.element?.querySelector(".xterm-viewport") as HTMLElement | null;
        if (viewport == null) {
            return;
        }
        const rect = viewport.getBoundingClientRect();
        const edgePx = Math.max(28, this.getTouchScrollLineHeight());
        if (clientY < rect.top + edgePx) {
            this.terminal.scrollLines(-1);
            return;
        }
        if (clientY > rect.bottom - edgePx) {
            this.terminal.scrollLines(1);
        }
    }

    private bufferCellToClientOffset(cell: { x: number; y: number }, endOfCell: boolean): { x: number; y: number } {
        const lineHeight = this.getTouchScrollLineHeight();
        const charWidth = this.getCharWidth();
        const viewportY = this.terminal.buffer.active.viewportY;
        const rowInView = cell.y - 1 - viewportY;
        const col = cell.x - 1 + (endOfCell ? 1 : 0);
        const rowsElem = this.terminal.element?.querySelector(".xterm-rows") as HTMLElement | null;
        const screenElem =
            (this.terminal.element?.querySelector(".xterm-screen") as HTMLElement | null) ?? this.terminal.element;
        if (screenElem == null) {
            return { x: 0, y: 0 };
        }
        const screenRect = screenElem.getBoundingClientRect();
        const rowsTop = rowsElem?.getBoundingClientRect().top ?? screenRect.top;
        return {
            x: screenRect.left + col * charWidth,
            y: rowsTop + rowInView * lineHeight + (endOfCell ? lineHeight : 0),
        };
    }

    private getCharWidth(): number {
        const rowElem = this.connectElem.querySelector(".xterm-rows > div") as HTMLElement | null;
        if (rowElem != null && this.terminal.cols > 0) {
            return rowElem.clientWidth / this.terminal.cols;
        }
        const fontSize = this.terminal.options.fontSize ?? 12;
        return fontSize * 0.6;
    }

    private getTouchScrollLineHeight(): number {
        const rowElem = this.connectElem.querySelector(".xterm-rows > div") as HTMLElement | null;
        if (rowElem?.offsetHeight) {
            return rowElem.offsetHeight;
        }
        const fontSize = this.terminal.options.fontSize ?? 12;
        return fontSize * 1.35;
    }

    private attachTouchInteractionHandler(): TermTypes.IDisposable {
        this.updateTouchTextSelectClass();

        type TouchMode = "none" | "scroll" | "select";
        let activeTouchId: number | null = null;
        let startX = 0;
        let startY = 0;
        let lastY = 0;
        let accumulatedPx = 0;
        let mode: TouchMode = "none";
        let longPressTimer: ReturnType<typeof setTimeout> | null = null;
        let longPressTriggered = false;
        let selectionExtendAnchor: { x: number; y: number } | null = null;

        const clearLongPressTimer = () => {
            if (longPressTimer != null) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        };

        const resetTouch = () => {
            clearLongPressTimer();
            activeTouchId = null;
            startX = 0;
            startY = 0;
            lastY = 0;
            accumulatedPx = 0;
            mode = "none";
            longPressTriggered = false;
            selectionExtendAnchor = null;
            this.touchSelectGestureActive = false;
            this.connectElem.classList.remove("term-touchscroll-enabled");
            this.connectElem.classList.remove("term-touchselect-active");
        };

        const findActiveTouch = (touches: TouchList): Touch | null => {
            if (activeTouchId == null) {
                return null;
            }
            for (const touch of Array.from(touches)) {
                if (touch.identifier === activeTouchId) {
                    return touch;
                }
            }
            return null;
        };

        const beginLongPressTimer = () => {
            if (!this.isTouchTextSelectEnabled()) {
                return;
            }
            clearLongPressTimer();
            longPressTimer = setTimeout(() => {
                longPressTimer = null;
                if (activeTouchId == null || mode !== "none") {
                    return;
                }
                longPressTriggered = true;
                if (!this.selectWordAtClient(startX, startY)) {
                    return;
                }
                mode = "select";
                this.touchSelectGestureActive = true;
                this.connectElem.classList.add("term-touchselect-active");
                this.terminal.focus();
                const selectionPos = this.terminal.getSelectionPosition();
                const touchCell = this.clientToBufferCell(startX, startY);
                if (selectionPos != null && touchCell != null) {
                    selectionExtendAnchor = this.getSelectionExtendAnchor(touchCell, selectionPos);
                }
                if (typeof navigator.vibrate === "function") {
                    navigator.vibrate(10);
                }
            }, TouchLongPressMs);
        };

        const commitScrollMode = () => {
            if (!this.isTouchScrollEnabled() || mode !== "none") {
                return false;
            }
            mode = "scroll";
            clearLongPressTimer();
            this.connectElem.classList.add("term-touchscroll-enabled");
            return true;
        };

        const onTouchStart = (e: TouchEvent) => {
            const scrollEnabled = this.isTouchScrollEnabled();
            const selectEnabled = this.isTouchTextSelectEnabled();
            if ((!scrollEnabled && !selectEnabled) || e.touches.length !== 1) {
                return;
            }
            const touch = e.touches[0];
            activeTouchId = touch.identifier;
            startX = touch.clientX;
            startY = touch.clientY;
            lastY = touch.clientY;
            accumulatedPx = 0;
            mode = "none";
            longPressTriggered = false;
            selectionExtendAnchor = null;
            if (selectEnabled && !this.terminal.hasSelection()) {
                beginLongPressTimer();
            } else if (scrollEnabled) {
                this.connectElem.classList.add("term-touchscroll-enabled");
            }
        };

        const onTouchMove = (e: TouchEvent) => {
            if (activeTouchId == null) {
                return;
            }
            if (e.touches.length !== 1) {
                resetTouch();
                return;
            }
            const touch = findActiveTouch(e.touches);
            if (touch == null) {
                return;
            }

            if (mode === "none" && !longPressTriggered) {
                const dx = Math.abs(touch.clientX - startX);
                const dy = Math.abs(touch.clientY - startY);
                const dist = Math.max(dx, dy);
                if (dist >= TouchLongPressMoveTolerancePx) {
                    clearLongPressTimer();
                    if (
                        this.isTouchScrollEnabled() &&
                        dy >= TouchGestureCommitThresholdPx &&
                        dy > dx * TouchScrollDominanceRatio
                    ) {
                        commitScrollMode();
                    }
                }
            }

            if (mode === "select") {
                e.preventDefault();
                if (selectionExtendAnchor != null) {
                    this.extendTouchSelection(selectionExtendAnchor, touch.clientX, touch.clientY);
                }
                return;
            }

            if (mode === "scroll" && this.isTouchScrollEnabled()) {
                e.preventDefault();
                const deltaY = lastY - touch.clientY;
                lastY = touch.clientY;
                accumulatedPx += deltaY;
                const lineHeight = this.getTouchScrollLineHeight();
                const lines = Math.trunc(accumulatedPx / lineHeight);
                if (lines !== 0) {
                    this.terminal.scrollLines(lines);
                    accumulatedPx -= lines * lineHeight;
                    if (this.terminal.hasSelection()) {
                        this.notifySelectionHandlesUpdate();
                    }
                }
            }
        };

        const onTouchEnd = (e: TouchEvent) => {
            if (activeTouchId == null) {
                return;
            }
            const touch = Array.from(e.changedTouches).find((t) => t.identifier === activeTouchId);
            if (touch == null) {
                return;
            }
            const endedMode = mode;
            const wasLongPress = longPressTriggered;
            resetTouch();
            if (endedMode === "select" || wasLongPress) {
                this.notifySelectionHandlesUpdate();
            }
        };

        const onContextMenu = (e: Event) => {
            if (longPressTriggered || mode === "select") {
                e.preventDefault();
            }
        };

        const touchOpts: AddEventListenerOptions = { passive: false };
        if (this.isTouchScrollEnabled() && !this.isTouchTextSelectEnabled()) {
            this.connectElem.classList.add("term-touchscroll-enabled");
        }
        this.connectElem.addEventListener("touchstart", onTouchStart, touchOpts);
        this.connectElem.addEventListener("touchmove", onTouchMove, touchOpts);
        this.connectElem.addEventListener("touchend", onTouchEnd);
        this.connectElem.addEventListener("touchcancel", onTouchEnd);
        this.connectElem.addEventListener("contextmenu", onContextMenu);

        return {
            dispose: () => {
                clearLongPressTimer();
                this.connectElem.classList.remove("term-touchscroll-enabled");
                this.connectElem.classList.remove("term-touchselect-active");
                this.connectElem.classList.remove("term-touchtextselect-enabled");
                this.connectElem.classList.remove("term-touchtextselect-disabled");
                this.connectElem.removeEventListener("touchstart", onTouchStart);
                this.connectElem.removeEventListener("touchmove", onTouchMove);
                this.connectElem.removeEventListener("touchend", onTouchEnd);
                this.connectElem.removeEventListener("touchcancel", onTouchEnd);
                this.connectElem.removeEventListener("contextmenu", onContextMenu);
            },
        };
    }

    getZoneId(): string {
        return this.blockId;
    }

    setCursorStyle(cursorStyle: string) {
        this.terminal.options.cursorStyle = normalizeCursorStyle(cursorStyle);
    }

    setCursorBlink(cursorBlink: boolean) {
        this.terminal.options.cursorBlink = cursorBlink ?? false;
    }

    setTermRenderer(renderer: "webgl" | "dom") {
        if (renderer === "webgl") {
            if (this.webglAddon != null) {
                return;
            }
            if (!WebGLSupported) {
                renderer = "dom";
            }
        } else {
            if (this.webglAddon == null) {
                return;
            }
        }
        if (this.webglAddon != null) {
            this.webglContextLossDisposable?.dispose();
            this.webglContextLossDisposable = null;
            this.webglAddon.dispose();
            this.webglAddon = null;
            globalStore.set(this.webglEnabledAtom, false);
        }
        if (renderer === "webgl") {
            const addon = new WebglAddon();
            this.webglContextLossDisposable = addon.onContextLoss(() => {
                this.setTermRenderer("dom");
            });
            this.terminal.loadAddon(addon);
            this.webglAddon = addon;
            globalStore.set(this.webglEnabledAtom, true);
            if (!loggedWebGL) {
                console.log("loaded webgl!");
                loggedWebGL = true;
            }
        }
    }

    getTermRenderer(): "webgl" | "dom" {
        return this.webglAddon != null ? "webgl" : "dom";
    }

    isWebGlEnabled(): boolean {
        return this.webglAddon != null;
    }

    async initTerminal() {
        const copyOnSelectAtom = getSettingsKeyAtom("term:copyonselect");
        const trimTrailingWhitespaceAtom = getSettingsKeyAtom("term:trimtrailingwhitespace");
        this.toDispose.push(this.terminal.onData(this.handleTermData.bind(this)));
        this.toDispose.push(
            this.terminal.onSelectionChange(
                debounce(50, () => {
                    if (!globalStore.get(copyOnSelectAtom)) {
                        return;
                    }
                    // Don't copy-on-select when the search bar has focus — navigating
                    // search results changes the terminal selection programmatically.
                    const active = document.activeElement;
                    if (active != null && active.closest(".search-container") != null) {
                        return;
                    }
                    let selectedText = this.terminal.getSelection();
                    if (selectedText.length > 0) {
                        if (globalStore.get(trimTrailingWhitespaceAtom) !== false) {
                            selectedText = trimTerminalSelection(selectedText);
                        }
                        navigator.clipboard.writeText(selectedText);
                    }
                })
            )
        );
        if (this.onSearchResultsDidChange != null) {
            this.toDispose.push(this.searchAddon.onDidChangeResults(this.onSearchResultsDidChange.bind(this)));
        }

        this.mainFileSubject = getFileSubject(this.getZoneId(), TermFileName);
        this.mainFileSubject.subscribe(this.handleNewFileSubjectData.bind(this));

        try {
            const rtInfo = await RpcApi.GetRTInfoCommand(TabRpcClient, {
                oref: WOS.makeORef("block", this.blockId),
            });
            let shellState: ShellIntegrationStatus = null;

            if (rtInfo && rtInfo["shell:integration"]) {
                shellState = rtInfo["shell:state"] as ShellIntegrationStatus;
                globalStore.set(this.shellIntegrationStatusAtom, shellState || null);
            } else {
                globalStore.set(this.shellIntegrationStatusAtom, null);
            }

            const lastCmd = rtInfo ? rtInfo["shell:lastcmd"] : null;
            const isCC = shellState === "running-command" && isClaudeCodeCommand(lastCmd);
            globalStore.set(this.lastCommandAtom, lastCmd || null);
            globalStore.set(this.claudeCodeActiveAtom, isCC);
        } catch (e) {
            console.log("Error loading runtime info:", e);
        }

        try {
            await this.loadInitialTerminalData();
        } finally {
            this.loaded = true;
        }
        this.runProcessIdleTimeout();
    }

    dispose() {
        this.promptMarkers.forEach((marker) => {
            try {
                marker.dispose();
            } catch (_) {
                /* nothing */
            }
        });
        this.promptMarkers = [];
        this.webglContextLossDisposable?.dispose();
        this.webglContextLossDisposable = null;
        this.terminal.dispose();
        this.toDispose.forEach((d) => {
            try {
                d.dispose();
            } catch (_) {
                /* nothing */
            }
        });
        this.mainFileSubject.release();
    }

    handleTermData(data: string) {
        if (!this.loaded) {
            return;
        }

        this.sendDataHandler?.(data);
        this.multiInputCallback?.(data);
    }

    addFocusListener(focusFn: () => void) {
        this.terminal.textarea.addEventListener("focus", focusFn);
    }

    handleNewFileSubjectData(msg: WSFileEventData) {
        if (msg.fileop == "truncate") {
            this.terminal.clear();
            this.heldData = [];
        } else if (msg.fileop == "append") {
            const decodedData = base64ToArray(msg.data64);
            if (this.loaded) {
                this.doTerminalWrite(decodedData, null);
            } else {
                this.heldData.push(decodedData);
            }
        } else {
            console.log("bad fileop for terminal", msg);
            return;
        }
    }

    doTerminalWrite(data: string | Uint8Array, setPtyOffset?: number): Promise<void> {
        if (isDev() && this.loaded) {
            const dataStr = data instanceof Uint8Array ? new TextDecoder().decode(data) : data;
            this.recentWrites.push({ idx: this.recentWritesCounter++, ts: Date.now(), data: dataStr });
            if (this.recentWrites.length > 50) {
                this.recentWrites.shift();
            }
        }
        let resolve: () => void = null;
        const prtn = new Promise<void>((presolve, _) => {
            resolve = presolve;
        });
        this.terminal.write(data, () => {
            if (setPtyOffset != null) {
                this.ptyOffset = setPtyOffset;
            } else {
                this.ptyOffset += data.length;
                this.dataBytesProcessed += data.length;
            }
            this.lastUpdated = Date.now();
            resolve();
        });
        return prtn;
    }

    async loadInitialTerminalData(): Promise<void> {
        const startTs = Date.now();
        const zoneId = this.getZoneId();
        const { data: cacheData, fileInfo: cacheFile } = await fetchWaveFile(zoneId, TermCacheFileName);
        let ptyOffset = 0;
        if (cacheFile != null) {
            ptyOffset = cacheFile.meta["ptyoffset"] ?? 0;
            if (cacheData.byteLength > 0) {
                const curTermSize: TermSize = { rows: this.terminal.rows, cols: this.terminal.cols };
                const fileTermSize: TermSize = cacheFile.meta["termsize"];
                let didResize = false;
                if (
                    fileTermSize != null &&
                    (fileTermSize.rows != curTermSize.rows || fileTermSize.cols != curTermSize.cols)
                ) {
                    console.log("terminal restore size mismatch, temp resize", fileTermSize, curTermSize);
                    this.terminal.resize(fileTermSize.cols, fileTermSize.rows);
                    didResize = true;
                }
                this.doTerminalWrite(cacheData, ptyOffset);
                if (didResize) {
                    this.terminal.resize(curTermSize.cols, curTermSize.rows);
                }
            }
        }
        const { data: mainData, fileInfo: mainFile } = await fetchWaveFile(zoneId, TermFileName, ptyOffset);
        console.log(
            `terminal loaded cachefile:${cacheData?.byteLength ?? 0} main:${mainData?.byteLength ?? 0} bytes, ${Date.now() - startTs}ms`
        );
        if (mainFile != null) {
            await this.doTerminalWrite(mainData, null);
        }
    }

    async resyncController(reason: string) {
        dlog("resync controller", this.blockId, reason);
        const rtOpts: RuntimeOpts = { termsize: { rows: this.terminal.rows, cols: this.terminal.cols } };
        try {
            await RpcApi.ControllerResyncCommand(TabRpcClient, {
                tabid: this.tabId,
                blockid: this.blockId,
                rtopts: rtOpts,
            });
        } catch (e) {
            console.log(`error controller resync (${reason})`, this.blockId, e);
        }
    }

    handleResize() {
        const oldRows = this.terminal.rows;
        const oldCols = this.terminal.cols;
        this.fitAddon.fit();
        if (oldRows !== this.terminal.rows || oldCols !== this.terminal.cols) {
            const termSize: TermSize = { rows: this.terminal.rows, cols: this.terminal.cols };
            console.log(
                "[termwrap] resize",
                `${oldRows}x${oldCols}`,
                "->",
                `${this.terminal.rows}x${this.terminal.cols}`
            );
            RpcApi.ControllerInputCommand(TabRpcClient, { blockid: this.blockId, termsize: termSize });
        }
        dlog("resize", `${this.terminal.rows}x${this.terminal.cols}`, `${oldRows}x${oldCols}`, this.hasResized);
        if (!this.hasResized) {
            this.hasResized = true;
            this.resyncController("initial resize");
        }
    }

    processAndCacheData() {
        if (this.dataBytesProcessed < MinDataProcessedForCache) {
            return;
        }
        const serializedOutput = this.serializeAddon.serialize();
        const termSize: TermSize = { rows: this.terminal.rows, cols: this.terminal.cols };
        console.log("idle timeout term", this.dataBytesProcessed, serializedOutput.length, termSize);
        fireAndForget(() =>
            services.BlockService.SaveTerminalState(this.blockId, serializedOutput, "full", this.ptyOffset, termSize)
        );
        this.dataBytesProcessed = 0;
    }

    runProcessIdleTimeout() {
        setTimeout(() => {
            window.requestIdleCallback(() => {
                this.processAndCacheData();
                this.runProcessIdleTimeout();
            });
        }, 5000);
    }

    async pasteHandler(e?: ClipboardEvent): Promise<void> {
        if (this.pasteActive) {
            e?.preventDefault();
            e?.stopPropagation();
            return;
        }

        this.pasteActive = true;
        e?.preventDefault();
        e?.stopPropagation();

        try {
            const clipboardData = await extractAllClipboardData(e);
            let firstImage = true;
            for (const data of clipboardData) {
                if (data.image && SupportsImageInput) {
                    if (!firstImage) {
                        await new Promise((r) => setTimeout(r, 150));
                    }
                    const tempPath = await createTempFileFromBlob(data.image);
                    this.terminal.paste(tempPath + " ");
                    firstImage = false;
                }
                if (data.text) {
                    this.terminal.paste(data.text);
                }
            }
        } catch (err) {
            console.error("Paste error:", err);
        } finally {
            setTimeout(() => {
                this.pasteActive = false;
            }, 30);
        }
    }

    getScrollbackContent(): string {
        if (!this.terminal) {
            return "";
        }
        const buffer = this.terminal.buffer.active;
        const lines = bufferLinesToText(buffer, 0, buffer.length);
        return lines.join("\n");
    }
}
