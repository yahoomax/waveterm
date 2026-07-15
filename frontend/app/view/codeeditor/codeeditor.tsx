// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { MonacoCodeEditor } from "@/app/monaco/monaco-react";
import { useOverrideConfigAtom } from "@/app/store/global";
import { boundNumber } from "@/util/util";
import clsx from "clsx";
import type * as MonacoTypes from "monaco-editor";
import * as MonacoModule from "monaco-editor";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { EditorSelectionHandles } from "./editor-selection-handles";
import { EditorTouchSelectController } from "./editor-touchselect-controller";
import "./codeeditor.scss";

function defaultEditorOptions(): MonacoTypes.editor.IEditorOptions {
    const opts: MonacoTypes.editor.IEditorOptions = {
        scrollBeyondLastLine: false,
        fontSize: 12,
        fontFamily: "Hack",
        smoothScrolling: true,
        scrollbar: {
            useShadows: false,
            verticalScrollbarSize: 5,
            horizontalScrollbarSize: 5,
        },
        minimap: {
            enabled: true,
        },
        stickyScroll: {
            enabled: false,
        },
    };
    return opts;
}

interface CodeEditorProps {
    blockId: string;
    text: string;
    readonly: boolean;
    language?: string;
    fileName?: string;
    onChange?: (text: string) => void;
    onMount?: (monacoPtr: MonacoTypes.editor.IStandaloneCodeEditor, monaco: typeof MonacoModule) => () => void;
}

export function CodeEditor({ blockId, text, language, fileName, readonly, onChange, onMount }: CodeEditorProps) {
    const divRef = useRef<HTMLDivElement>(null);
    const unmountRef = useRef<() => void>(null);
    const editorRef = useRef<MonacoTypes.editor.IStandaloneCodeEditor | null>(null);
    const touchSelectController = useMemo(() => new EditorTouchSelectController(), []);
    const [handlesController, setHandlesController] = useState<EditorTouchSelectController | null>(null);
    const minimapEnabled = useOverrideConfigAtom(blockId, "editor:minimapenabled") ?? false;
    const stickyScrollEnabled = useOverrideConfigAtom(blockId, "editor:stickyscrollenabled") ?? false;
    const wordWrap = useOverrideConfigAtom(blockId, "editor:wordwrap") ?? false;
    const fontSize = boundNumber(useOverrideConfigAtom(blockId, "editor:fontsize"), 6, 64);
    const touchTextSelectEnabled = useOverrideConfigAtom(blockId, "editor:touchtextselect") !== false;
    const uuidRef = useRef(crypto.randomUUID()).current;
    let editorPath: string;
    if (fileName) {
        const separator = fileName.startsWith("/") ? "" : "/";
        editorPath = blockId + separator + fileName;
    } else {
        editorPath = uuidRef;
    }

    useEffect(() => {
        return () => {
            touchSelectController.detach();
            setHandlesController(null);
            if (unmountRef.current) {
                unmountRef.current();
            }
        };
    }, [touchSelectController]);

    useEffect(() => {
        if (editorRef.current == null) {
            return;
        }
        if (touchTextSelectEnabled) {
            touchSelectController.attach(editorRef.current);
            setHandlesController(touchSelectController);
            return;
        }
        touchSelectController.detach();
        setHandlesController(null);
    }, [touchSelectController, touchTextSelectEnabled]);

    function handleEditorChange(text: string) {
        if (onChange) {
            onChange(text);
        }
    }

    function handleEditorOnMount(
        editor: MonacoTypes.editor.IStandaloneCodeEditor,
        monaco: typeof MonacoModule
    ): () => void {
        editorRef.current = editor;
        if (touchTextSelectEnabled) {
            touchSelectController.attach(editor);
            setHandlesController(touchSelectController);
        } else {
            touchSelectController.detach();
            setHandlesController(null);
        }
        if (onMount) {
            const cleanup = onMount(editor, monaco);
            unmountRef.current = cleanup;
            return () => {
                touchSelectController.detach();
                setHandlesController(null);
                editorRef.current = null;
                cleanup?.();
            };
        }
        return () => {
            touchSelectController.detach();
            setHandlesController(null);
            editorRef.current = null;
        };
    }

    const editorOpts = useMemo(() => {
        const opts = defaultEditorOptions();
        opts.minimap.enabled = minimapEnabled;
        opts.stickyScroll.enabled = stickyScrollEnabled;
        opts.wordWrap = wordWrap ? "on" : "off";
        opts.fontSize = fontSize;
        opts.copyWithSyntaxHighlighting = false;
        return opts;
    }, [minimapEnabled, stickyScrollEnabled, wordWrap, fontSize, readonly]);

    return (
        <div
            className={clsx(
                "codeeditor-wrap flex flex-col w-full h-full items-center justify-center",
                touchTextSelectEnabled ? "editor-touchtextselect-enabled" : "editor-touchtextselect-disabled"
            )}
        >
            <div className="flex flex-col h-full w-full" ref={divRef}>
                <MonacoCodeEditor
                    readonly={readonly}
                    text={text}
                    options={editorOpts}
                    onChange={handleEditorChange}
                    onMount={handleEditorOnMount}
                    path={editorPath}
                    language={language}
                />
            </div>
            <EditorSelectionHandles controller={handlesController} blockId={blockId} />
        </div>
    );
}
