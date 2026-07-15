// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getOverrideConfigAtom, globalStore } from "@/app/store/global";
import type * as MonacoTypes from "monaco-editor";
import { debounce } from "throttle-debounce";

export function attachEditorCopyOnSelect(
    editor: MonacoTypes.editor.IStandaloneCodeEditor,
    blockId: string
): MonacoTypes.IDisposable {
    const copyOnSelect = debounce(50, () => {
        if (globalStore.get(getOverrideConfigAtom(blockId, "editor:copyonselect")) === false) {
            return;
        }
        const selection = editor.getSelection();
        if (selection == null || selection.isEmpty()) {
            return;
        }
        const model = editor.getModel();
        if (model == null) {
            return;
        }
        const text = model.getValueInRange(selection);
        if (text.length > 0) {
            void navigator.clipboard.writeText(text);
        }
    });
    return editor.onDidChangeCursorSelection(copyOnSelect);
}
