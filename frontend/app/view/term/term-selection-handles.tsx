// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getOverrideConfigAtom } from "@/store/global";
import { useAtomValueSafe } from "@/util/util";
import * as React from "react";
import type { TermWrap } from "./termwrap";
import "./term-selection-handles.scss";

type HandlePoint = { left: number; top: number };
type HandleRenderPositions = { start: HandlePoint; end: HandlePoint };

const HANDLE_ICON_WIDTH_PX = 32;
const HANDLE_ICON_HEIGHT_PX = 38;

// Teardrop with tip at the bottom center of the viewBox.
const HANDLE_PATH =
    "M12 1.5C6.75 1.5 2.5 5.75 2.5 11c0 3.9 6.8 12.4 8.8 14.8.45.55 1.25.55 1.7 0C15.5 23.4 21.5 14.9 21.5 11 21.5 5.75 17.25 1.5 12 1.5z";

function SelectionHandleIcon({ variant }: { variant: "start" | "end" }) {
    return (
        <svg
            className={`term-selection-handle-icon term-selection-handle-icon-${variant}`}
            viewBox="0 0 24 28"
            width={HANDLE_ICON_WIDTH_PX}
            height={HANDLE_ICON_HEIGHT_PX}
            aria-hidden="true"
        >
            <path d={HANDLE_PATH} fill="currentColor" />
        </svg>
    );
}

interface TermSelectionHandlesProps {
    termWrap: TermWrap | null;
    blockId: string;
}

export const TermSelectionHandles = React.memo(function TermSelectionHandles({
    termWrap,
    blockId,
}: TermSelectionHandlesProps) {
    const touchSelectEnabled = useAtomValueSafe(getOverrideConfigAtom(blockId, "term:touchtextselect")) !== false;
    const [positions, setPositions] = React.useState<HandleRenderPositions | null>(null);
    const [adjustingHandle, setAdjustingHandle] = React.useState<"start" | "end" | null>(null);
    const adjustingHandleRef = React.useRef<"start" | "end" | null>(null);
    const rafRef = React.useRef<number | null>(null);

    const updatePositions = React.useCallback(() => {
        if (
            !termWrap ||
            !touchSelectEnabled ||
            (termWrap.isTouchSelectGestureActive() && adjustingHandleRef.current == null)
        ) {
            setPositions(null);
            return;
        }
        const tips = termWrap.getSelectionHandlePositions();
        if (tips == null) {
            setPositions(null);
            return;
        }
        const connectRect = termWrap.connectElem.getBoundingClientRect();
        const offsetParent = termWrap.connectElem.parentElement;
        const offsetRect = offsetParent?.getBoundingClientRect() ?? connectRect;
        setPositions({
            start: {
                left: connectRect.left + tips.start.left - offsetRect.left,
                top: connectRect.top + tips.start.top - offsetRect.top,
            },
            end: {
                left: connectRect.left + tips.end.left - offsetRect.left,
                top: connectRect.top + tips.end.top - offsetRect.top,
            },
        });
    }, [termWrap, touchSelectEnabled]);

    const scheduleUpdate = React.useCallback(() => {
        if (rafRef.current != null) {
            return;
        }
        rafRef.current = requestAnimationFrame(() => {
            rafRef.current = null;
            updatePositions();
        });
    }, [updatePositions]);

    React.useEffect(() => {
        const terminal = termWrap?.terminal;
        if (!terminal || !touchSelectEnabled) {
            setPositions(null);
            return;
        }

        scheduleUpdate();
        const selectionDispose = terminal.onSelectionChange(scheduleUpdate);
        const scrollDispose = terminal.onScroll(scheduleUpdate);
        const renderDispose = terminal.onRender(scheduleUpdate);
        const unsubscribeHandles = termWrap.subscribeSelectionHandlesUpdate(scheduleUpdate);

        const viewport = terminal.element?.querySelector(".xterm-viewport");
        viewport?.addEventListener("scroll", scheduleUpdate, { passive: true });

        const selectionLayer = terminal.element?.querySelector(".xterm-selection");
        const selectionObserver =
            selectionLayer != null
                ? new MutationObserver(scheduleUpdate)
                : null;
        if (selectionLayer != null && selectionObserver != null) {
            selectionObserver.observe(selectionLayer, {
                attributes: true,
                childList: true,
                subtree: true,
            });
        }

        const resizeObserver = new ResizeObserver(scheduleUpdate);
        if (termWrap.connectElem) {
            resizeObserver.observe(termWrap.connectElem);
        }
        window.addEventListener("scroll", scheduleUpdate, { passive: true, capture: true });

        return () => {
            selectionDispose.dispose();
            scrollDispose.dispose();
            renderDispose.dispose();
            unsubscribeHandles();
            viewport?.removeEventListener("scroll", scheduleUpdate);
            selectionObserver?.disconnect();
            resizeObserver.disconnect();
            window.removeEventListener("scroll", scheduleUpdate, { capture: true });
            if (rafRef.current != null) {
                cancelAnimationFrame(rafRef.current);
                rafRef.current = null;
            }
        };
    }, [termWrap, touchSelectEnabled, scheduleUpdate]);

    const startAdjust = React.useCallback(
        (handle: "start" | "end", clientX: number, clientY: number) => {
            if (!termWrap) {
                return;
            }
            adjustingHandleRef.current = handle;
            setAdjustingHandle(handle);
            termWrap.beginSelectionHandleAdjust(handle);
            termWrap.updateSelectionHandleAdjust(clientX, clientY);
            scheduleUpdate();
        },
        [termWrap, scheduleUpdate]
    );

    const moveAdjust = React.useCallback(
        (clientX: number, clientY: number) => {
            if (!termWrap || adjustingHandleRef.current == null) {
                return;
            }
            termWrap.updateSelectionHandleAdjust(clientX, clientY);
            scheduleUpdate();
        },
        [termWrap, scheduleUpdate]
    );

    const endAdjust = React.useCallback(
        (clientX: number, clientY: number) => {
            if (!termWrap || adjustingHandleRef.current == null) {
                return;
            }
            termWrap.endSelectionHandleAdjust(clientX, clientY);
            adjustingHandleRef.current = null;
            setAdjustingHandle(null);
            scheduleUpdate();
        },
        [termWrap, scheduleUpdate]
    );

    const attachDocumentDrag = React.useCallback(
        (handle: "start" | "end", startX: number, startY: number) => {
            if (!termWrap) {
                return;
            }
            const tips = termWrap.getSelectionHandlePositions();
            if (tips == null) {
                return;
            }
            const connectRect = termWrap.connectElem.getBoundingClientRect();
            const tip = handle === "start" ? tips.start : tips.end;
            const tipClientX = connectRect.left + tip.left;
            const tipClientY = connectRect.top + tip.top;
            const fingerToTipOffsetX = startX - tipClientX;
            const fingerToTipOffsetY = startY - tipClientY;
            const toTipCoords = (clientX: number, clientY: number) => ({
                x: clientX - fingerToTipOffsetX,
                y: clientY - fingerToTipOffsetY,
            });
            const startTip = toTipCoords(startX, startY);
            startAdjust(handle, startTip.x, startTip.y);

            const onTouchMove = (e: TouchEvent) => {
                if (e.touches.length !== 1) {
                    return;
                }
                e.preventDefault();
                const tipCoords = toTipCoords(e.touches[0].clientX, e.touches[0].clientY);
                moveAdjust(tipCoords.x, tipCoords.y);
            };
            const onTouchEnd = (e: TouchEvent) => {
                const touch = e.changedTouches[0];
                if (touch != null) {
                    const tipCoords = toTipCoords(touch.clientX, touch.clientY);
                    endAdjust(tipCoords.x, tipCoords.y);
                }
                cleanup();
            };
            const onMouseMove = (e: MouseEvent) => {
                e.preventDefault();
                const tipCoords = toTipCoords(e.clientX, e.clientY);
                moveAdjust(tipCoords.x, tipCoords.y);
            };
            const onMouseUp = (e: MouseEvent) => {
                const tipCoords = toTipCoords(e.clientX, e.clientY);
                endAdjust(tipCoords.x, tipCoords.y);
                cleanup();
            };
            const cleanup = () => {
                document.removeEventListener("touchmove", onTouchMove);
                document.removeEventListener("touchend", onTouchEnd);
                document.removeEventListener("touchcancel", onTouchEnd);
                window.removeEventListener("mousemove", onMouseMove);
                window.removeEventListener("mouseup", onMouseUp);
            };

            document.addEventListener("touchmove", onTouchMove, { passive: false });
            document.addEventListener("touchend", onTouchEnd);
            document.addEventListener("touchcancel", onTouchEnd);
            window.addEventListener("mousemove", onMouseMove);
            window.addEventListener("mouseup", onMouseUp);
        },
        [startAdjust, moveAdjust, endAdjust, termWrap]
    );

    const bindHandleEvents = (handle: "start" | "end") => ({
        onTouchStart: (e: React.TouchEvent) => {
            e.stopPropagation();
            if (e.touches.length !== 1) {
                return;
            }
            const touch = e.touches[0];
            attachDocumentDrag(handle, touch.clientX, touch.clientY);
        },
        onMouseDown: (e: React.MouseEvent) => {
            e.stopPropagation();
            e.preventDefault();
            attachDocumentDrag(handle, e.clientX, e.clientY);
        },
    });

    if (!positions) {
        return null;
    }

    return (
        <div className="term-selection-handles" aria-hidden="true">
            <div
                className={`term-selection-handle term-selection-handle-start${adjustingHandle === "start" ? " is-adjusting" : ""}`}
                style={{ left: positions.start.left, top: positions.start.top }}
                {...bindHandleEvents("start")}
            >
                <SelectionHandleIcon variant="start" />
            </div>
            <div
                className={`term-selection-handle term-selection-handle-end${adjustingHandle === "end" ? " is-adjusting" : ""}`}
                style={{ left: positions.end.left, top: positions.end.top }}
                {...bindHandleEvents("end")}
            >
                <SelectionHandleIcon variant="end" />
            </div>
        </div>
    );
});
