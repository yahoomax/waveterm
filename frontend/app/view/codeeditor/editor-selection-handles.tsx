// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getOverrideConfigAtom } from "@/store/global";
import { useAtomValueSafe } from "@/util/util";
import * as React from "react";
import type { EditorTouchSelectController } from "./editor-touchselect-controller";
import "./editor-selection-handles.scss";

type HandlePoint = { left: number; top: number };
type HandleRenderPositions = { start: HandlePoint; end: HandlePoint };

const HANDLE_ICON_WIDTH_PX = 32;
const HANDLE_ICON_HEIGHT_PX = 38;

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

interface EditorSelectionHandlesProps {
    controller: EditorTouchSelectController | null;
    blockId: string;
}

export const EditorSelectionHandles = React.memo(function EditorSelectionHandles({
    controller,
    blockId,
}: EditorSelectionHandlesProps) {
    const touchSelectEnabled = useAtomValueSafe(getOverrideConfigAtom(blockId, "editor:touchtextselect")) !== false;
    const [positions, setPositions] = React.useState<HandleRenderPositions | null>(null);
    const [adjustingHandle, setAdjustingHandle] = React.useState<"start" | "end" | null>(null);
    const adjustingHandleRef = React.useRef<"start" | "end" | null>(null);
    const rafRef = React.useRef<number | null>(null);

    const updatePositions = React.useCallback(() => {
        const container = controller?.getContainerElem();
        if (
            !controller ||
            !container ||
            !touchSelectEnabled ||
            (controller.isTouchSelectGestureActive() && adjustingHandleRef.current == null)
        ) {
            setPositions(null);
            return;
        }
        const tips = controller.getSelectionHandlePositions();
        if (tips == null) {
            setPositions(null);
            return;
        }
        const containerRect = container.getBoundingClientRect();
        const offsetParent = container.parentElement;
        const offsetRect = offsetParent?.getBoundingClientRect() ?? containerRect;
        setPositions({
            start: {
                left: containerRect.left + tips.start.left - offsetRect.left,
                top: containerRect.top + tips.start.top - offsetRect.top,
            },
            end: {
                left: containerRect.left + tips.end.left - offsetRect.left,
                top: containerRect.top + tips.end.top - offsetRect.top,
            },
        });
    }, [controller, touchSelectEnabled]);

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
        const container = controller?.getContainerElem();
        if (!controller || !container || !touchSelectEnabled) {
            setPositions(null);
            return;
        }

        scheduleUpdate();
        const unsubscribeHandles = controller.subscribeSelectionHandlesUpdate(scheduleUpdate);

        const scrollable = container.querySelector(".monaco-scrollable-element");
        scrollable?.addEventListener("scroll", scheduleUpdate, { passive: true });

        const resizeObserver = new ResizeObserver(scheduleUpdate);
        resizeObserver.observe(container);
        if (container.parentElement != null) {
            resizeObserver.observe(container.parentElement);
        }
        window.addEventListener("scroll", scheduleUpdate, { passive: true, capture: true });

        return () => {
            unsubscribeHandles();
            scrollable?.removeEventListener("scroll", scheduleUpdate);
            resizeObserver.disconnect();
            window.removeEventListener("scroll", scheduleUpdate, { capture: true });
            if (rafRef.current != null) {
                cancelAnimationFrame(rafRef.current);
                rafRef.current = null;
            }
        };
    }, [controller, touchSelectEnabled, scheduleUpdate]);

    const startAdjust = React.useCallback(
        (handle: "start" | "end", clientX: number, clientY: number) => {
            if (!controller) {
                return;
            }
            adjustingHandleRef.current = handle;
            setAdjustingHandle(handle);
            controller.beginSelectionHandleAdjust(handle);
            controller.updateSelectionHandleAdjust(clientX, clientY);
            scheduleUpdate();
        },
        [controller, scheduleUpdate]
    );

    const moveAdjust = React.useCallback(
        (clientX: number, clientY: number) => {
            if (!controller || adjustingHandleRef.current == null) {
                return;
            }
            controller.updateSelectionHandleAdjust(clientX, clientY);
            scheduleUpdate();
        },
        [controller, scheduleUpdate]
    );

    const endAdjust = React.useCallback(
        (clientX: number, clientY: number) => {
            if (!controller || adjustingHandleRef.current == null) {
                return;
            }
            controller.endSelectionHandleAdjust(clientX, clientY);
            adjustingHandleRef.current = null;
            setAdjustingHandle(null);
            scheduleUpdate();
        },
        [controller, scheduleUpdate]
    );

    const attachDocumentDrag = React.useCallback(
        (handle: "start" | "end", startX: number, startY: number) => {
            const container = controller?.getContainerElem();
            if (!controller || !container) {
                return;
            }
            const tips = controller.getSelectionHandlePositions();
            if (tips == null) {
                return;
            }
            const containerRect = container.getBoundingClientRect();
            const tip = handle === "start" ? tips.start : tips.end;
            const tipClientX = containerRect.left + tip.left;
            const tipClientY = containerRect.top + tip.top;
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
        [startAdjust, moveAdjust, endAdjust, controller]
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
        <div className="editor-selection-handles" aria-hidden="true">
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
