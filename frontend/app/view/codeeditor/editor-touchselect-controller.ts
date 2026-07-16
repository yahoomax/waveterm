// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type * as MonacoTypes from "monaco-editor";
import * as monaco from "monaco-editor";

const TouchGestureCommitThresholdPx = 10;
const TouchHorizontalDominanceRatio = 1.5;
let syncingSelectionVisual = false;

function fixSelectionVisualMismatch(editor: MonacoTypes.editor.IStandaloneCodeEditor): void {
    if (syncingSelectionVisual) {
        return;
    }
    const modelSelection = editor.getSelection();
    if (modelSelection == null || modelSelection.isEmpty()) {
        return;
    }

    syncingSelectionVisual = true;
    try {
        const container = editor.getContainerDomNode();
        const textarea = container.querySelector("textarea.inputarea") as HTMLTextAreaElement | null;
        if (textarea != null && textarea.selectionStart !== textarea.selectionEnd) {
            const caret = textarea.selectionEnd;
            try {
                textarea.setSelectionRange(caret, caret);
            } catch {
                // ignore when the hidden textarea cannot be updated
            }
        }

        const nativeSelection = window.getSelection();
        if (nativeSelection != null && !nativeSelection.isEmpty()) {
            const anchorNode = nativeSelection.anchorNode;
            if (anchorNode != null && container.contains(anchorNode) && anchorNode !== textarea) {
                nativeSelection.removeAllRanges();
            }
        }

        editor.setSelection(modelSelection);
    } finally {
        syncingSelectionVisual = false;
    }
}

function scheduleSelectionVisualFix(editor: MonacoTypes.editor.IStandaloneCodeEditor): void {
    requestAnimationFrame(() => {
        fixSelectionVisualMismatch(editor);
        requestAnimationFrame(() => {
            fixSelectionVisualMismatch(editor);
        });
    });
}

export type EditorHandlePoint = { left: number; top: number };
export type EditorHandlePositions = { start: EditorHandlePoint; end: EditorHandlePoint };

export class EditorTouchSelectController {
    private editor: MonacoTypes.editor.IStandaloneCodeEditor | null = null;
    private touchCleanup: (() => void) | null = null;
    private selectionDispose: MonacoTypes.IDisposable | null = null;
    private scrollDispose: MonacoTypes.IDisposable | null = null;
    private selectionHandlesUpdateListeners = new Set<() => void>();
    private selectionAdjustAnchor: MonacoTypes.Position | null = null;
    private selectionAdjustHandle: "start" | "end" | null = null;
    private selectionVisualSyncRaf: number | null = null;
    private selectionChangeCleanup: (() => void) | null = null;
    touchSelectGestureActive = false;

    attach(editor: MonacoTypes.editor.IStandaloneCodeEditor): void {
        this.detach();
        this.editor = editor;
        this.touchCleanup = this.attachTouchHandlers();
        this.selectionChangeCleanup = this.attachSelectionVisualSync(editor);
        this.selectionDispose = editor.onDidChangeCursorSelection(() => {
            this.scheduleSelectionVisualFix();
            this.notifySelectionHandlesUpdate();
        });
        this.scrollDispose = editor.onDidScrollChange(() => {
            this.notifySelectionHandlesUpdate();
        });
    }

    detach(): void {
        this.touchCleanup?.();
        this.touchCleanup = null;
        this.selectionDispose?.dispose();
        this.selectionDispose = null;
        this.scrollDispose?.dispose();
        this.scrollDispose = null;
        this.selectionChangeCleanup?.();
        this.selectionChangeCleanup = null;
        if (this.selectionVisualSyncRaf != null) {
            cancelAnimationFrame(this.selectionVisualSyncRaf);
            this.selectionVisualSyncRaf = null;
        }
        this.selectionAdjustAnchor = null;
        this.selectionAdjustHandle = null;
        this.touchSelectGestureActive = false;
        this.editor = null;
    }

    getContainerElem(): HTMLElement | null {
        return this.editor?.getContainerDomNode() ?? null;
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

    notifySelectionHandlesUpdate(): void {
        requestAnimationFrame(() => {
            for (const listener of this.selectionHandlesUpdateListeners) {
                listener();
            }
        });
    }

    getSelectionHandlePositions(): EditorHandlePositions | null {
        const editor = this.editor;
        if (editor == null) {
            return null;
        }
        const selection = editor.getSelection();
        if (selection == null || selection.isEmpty()) {
            return null;
        }
        const container = editor.getContainerDomNode();
        const containerRect = container.getBoundingClientRect();
        const startPos = selection.getStartPosition();
        const endCharPos = this.getSelectionEndCharPosition(selection);
        if (endCharPos == null) {
            return null;
        }
        const startClient = this.positionToClientAnchor(startPos, "start");
        const endClient = this.positionToClientAnchor(endCharPos, "end");
        if (startClient == null || endClient == null) {
            return null;
        }
        return {
            start: {
                left: startClient.left - containerRect.left,
                top: startClient.top - containerRect.top,
            },
            end: {
                left: endClient.left - containerRect.left,
                top: endClient.top - containerRect.top,
            },
        };
    }

    beginSelectionHandleAdjust(handle: "start" | "end"): void {
        const editor = this.editor;
        const selection = editor?.getSelection();
        if (editor == null || selection == null || selection.isEmpty()) {
            return;
        }
        this.selectionAdjustHandle = handle;
        this.touchSelectGestureActive = true;
        if (handle === "start") {
            this.selectionAdjustAnchor = selection.getEndPosition();
            return;
        }
        this.selectionAdjustAnchor = selection.getStartPosition();
    }

    updateSelectionHandleAdjust(clientX: number, clientY: number): void {
        const editor = this.editor;
        if (editor == null || this.selectionAdjustAnchor == null || this.selectionAdjustHandle == null) {
            return;
        }
        this.autoScrollWhileSelecting(clientY);
        const movingPosition = this.positionAt(clientX, clientY);
        if (movingPosition == null) {
            return;
        }
        if (this.selectionAdjustHandle === "start") {
            this.applyEditorSelection(
                editor,
                monaco.Selection.fromPositions(movingPosition, this.selectionAdjustAnchor)
            );
        } else {
            this.applyEditorSelection(
                editor,
                monaco.Selection.fromPositions(this.selectionAdjustAnchor, movingPosition)
            );
        }
    }

    endSelectionHandleAdjust(clientX: number, clientY: number): void {
        this.updateSelectionHandleAdjust(clientX, clientY);
        this.selectionAdjustHandle = null;
        this.selectionAdjustAnchor = null;
        this.touchSelectGestureActive = false;
        const editor = this.editor;
        if (editor != null) {
            scheduleSelectionVisualFix(editor);
        }
        this.notifySelectionHandlesUpdate();
    }

    private scheduleSelectionVisualFix(): void {
        const editor = this.editor;
        if (editor == null || syncingSelectionVisual) {
            return;
        }
        if (this.selectionVisualSyncRaf != null) {
            cancelAnimationFrame(this.selectionVisualSyncRaf);
        }
        this.selectionVisualSyncRaf = requestAnimationFrame(() => {
            this.selectionVisualSyncRaf = null;
            if (this.editor == null) {
                return;
            }
            fixSelectionVisualMismatch(this.editor);
        });
    }

    private attachSelectionVisualSync(editor: MonacoTypes.editor.IStandaloneCodeEditor): () => void {
        const onSelectionChange = () => {
            if (syncingSelectionVisual) {
                return;
            }
            const selection = editor.getSelection();
            if (selection == null || selection.isEmpty()) {
                return;
            }
            this.scheduleSelectionVisualFix();
        };
        document.addEventListener("selectionchange", onSelectionChange);
        return () => {
            document.removeEventListener("selectionchange", onSelectionChange);
        };
    }

    private applyEditorSelection(
        editor: MonacoTypes.editor.IStandaloneCodeEditor,
        selection: MonacoTypes.Selection
    ): void {
        editor.setSelection(selection);
        editor.focus();
        scheduleSelectionVisualFix(editor);
        this.notifySelectionHandlesUpdate();
    }

    private getSelectionEndCharPosition(selection: MonacoTypes.Selection): MonacoTypes.Position | null {
        const editor = this.editor;
        const model = editor?.getModel();
        if (editor == null || model == null) {
            return null;
        }
        const end = selection.getEndPosition();
        if (end.column > 1) {
            return new monaco.Position(end.lineNumber, end.column - 1);
        }
        if (end.lineNumber <= 1) {
            return new monaco.Position(1, 1);
        }
        const prevLine = end.lineNumber - 1;
        const prevCol = Math.max(1, model.getLineMaxColumn(prevLine) - 1);
        return new monaco.Position(prevLine, prevCol);
    }

    private positionToClientAnchor(
        position: MonacoTypes.Position,
        edge: "start" | "end"
    ): EditorHandlePoint | null {
        const editor = this.editor;
        if (editor == null) {
            return null;
        }
        const visible = editor.getScrolledVisiblePosition(position);
        if (visible == null) {
            return null;
        }
        const containerRect = editor.getContainerDomNode().getBoundingClientRect();
        const layoutInfo = editor.getLayoutInfo();
        const column = edge === "end" ? position.column + 1 : position.column;
        const left =
            layoutInfo.contentLeft +
            editor.getOffsetForColumn(position.lineNumber, column) -
            editor.getScrollLeft();
        return {
            left: containerRect.left + left,
            top: containerRect.top + visible.top + visible.height,
        };
    }

    private positionAt(clientX: number, clientY: number): MonacoTypes.Position | null {
        const editor = this.editor;
        if (editor == null) {
            return null;
        }
        return editor.getTargetAtClientPoint(clientX, clientY)?.position ?? null;
    }

    private autoScrollWhileSelecting(clientY: number): void {
        const editor = this.editor;
        const domNode = editor?.getDomNode();
        if (editor == null || domNode == null) {
            return;
        }
        const rect = domNode.getBoundingClientRect();
        const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
        const edgePx = Math.max(28, lineHeight);
        if (clientY < rect.top + edgePx) {
            editor.setScrollTop(Math.max(0, editor.getScrollTop() - lineHeight));
            return;
        }
        if (clientY > rect.bottom - edgePx) {
            editor.setScrollTop(editor.getScrollTop() + lineHeight);
        }
    }

    private setTouchSelectGestureActive(active: boolean): void {
        this.touchSelectGestureActive = active;
        this.notifySelectionHandlesUpdate();
    }

    private attachTouchHandlers(): () => void {
        const editor = this.editor;
        if (editor == null) {
            return () => {};
        }
        const container = editor.getContainerDomNode();

        type TouchMode = "none" | "select";
        let activeTouchId: number | null = null;
        let startX = 0;
        let startY = 0;
        let mode: TouchMode = "none";
        let anchorPosition: MonacoTypes.Position | null = null;

        const resetTouch = () => {
            activeTouchId = null;
            mode = "none";
            anchorPosition = null;
            container.classList.remove("editor-touchselect-active");
            this.setTouchSelectGestureActive(false);
        };

        const updateSelection = (clientX: number, clientY: number): void => {
            if (anchorPosition == null || editor == null) {
                return;
            }
            const endPosition = this.positionAt(clientX, clientY);
            if (endPosition == null) {
                return;
            }
            this.applyEditorSelection(
                editor,
                monaco.Selection.fromPositions(anchorPosition, endPosition)
            );
        };

        const commitSelectMode = (clientX: number, clientY: number): void => {
            const pos = this.positionAt(startX, startY);
            if (pos == null) {
                return;
            }
            mode = "select";
            anchorPosition = pos;
            container.classList.add("editor-touchselect-active");
            this.setTouchSelectGestureActive(true);
            updateSelection(clientX, clientY);
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

        const onTouchStart = (e: TouchEvent) => {
            if (e.touches.length !== 1) {
                return;
            }
            const touch = e.touches[0];
            activeTouchId = touch.identifier;
            startX = touch.clientX;
            startY = touch.clientY;
            mode = "none";
            anchorPosition = null;
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

            if (mode === "select") {
                e.preventDefault();
                updateSelection(touch.clientX, touch.clientY);
                return;
            }

            if (mode === "none") {
                const dx = Math.abs(touch.clientX - startX);
                const dy = Math.abs(touch.clientY - startY);
                if (dx >= TouchGestureCommitThresholdPx && dx > dy * TouchHorizontalDominanceRatio) {
                    e.preventDefault();
                    commitSelectMode(touch.clientX, touch.clientY);
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
            const hadSelection = mode === "select";
            resetTouch();
            if (hadSelection) {
                editor.focus();
                scheduleSelectionVisualFix(editor);
            }
            this.notifySelectionHandlesUpdate();
        };

        const onSelectStart = (e: Event) => {
            e.preventDefault();
        };

        const touchOpts: AddEventListenerOptions = { passive: false };
        container.addEventListener("selectstart", onSelectStart);
        container.addEventListener("touchstart", onTouchStart, touchOpts);
        container.addEventListener("touchmove", onTouchMove, touchOpts);
        container.addEventListener("touchend", onTouchEnd);
        container.addEventListener("touchcancel", onTouchEnd);

        return () => {
            resetTouch();
            container.removeEventListener("selectstart", onSelectStart);
            container.removeEventListener("touchstart", onTouchStart);
            container.removeEventListener("touchmove", onTouchMove);
            container.removeEventListener("touchend", onTouchEnd);
            container.removeEventListener("touchcancel", onTouchEnd);
        };
    }
}
