// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Monaco does not ship a dedicated csh/tcsh grammar; map those files to shell highlighting.

const FILENAME_LANGUAGE_MAP: Record<string, string> = {
    ".bashrc": "shell",
    ".bash_profile": "shell",
    ".bash_login": "shell",
    ".bash_logout": "shell",
    ".profile": "shell",
    ".zshrc": "shell",
    ".zprofile": "shell",
    ".zshenv": "shell",
    ".zlogin": "shell",
    ".zlogout": "shell",
    ".kshrc": "shell",
    ".cshrc": "shell",
    ".tcshrc": "shell",
    ".login": "shell",
    ".logout": "shell",
    ".shrc": "shell",
    ".aliases": "shell",
    ".functions": "shell",
    ".exports": "shell",
    ".direnvrc": "shell",
    ".vimrc": "shell",
    ".gvimrc": "shell",
    ".xonshrc": "python",
    dockerfile: "dockerfile",
    containerfile: "dockerfile",
};

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
    ".sh": "shell",
    ".bash": "shell",
    ".zsh": "shell",
    ".ksh": "shell",
    ".csh": "shell",
    ".tcsh": "shell",
    ".fish": "shell",
    ".ps1": "powershell",
    ".psm1": "powershell",
    ".psd1": "powershell",
    ".psrc": "powershell",
    ".pl": "perl",
    ".pm": "perl",
    ".t": "perl",
    ".pod": "perl",
    ".tcl": "tcl",
    ".tk": "tcl",
    ".rb": "ruby",
    ".erb": "ruby",
    ".lua": "lua",
    ".bat": "bat",
    ".cmd": "bat",
    ".dockerfile": "dockerfile",
};

const EXTENDED_LANGUAGE_LOADERS: Record<string, () => Promise<unknown>> = {
    shell: () => import("monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js"),
    powershell: () => import("monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution.js"),
    perl: () => import("monaco-editor/esm/vs/basic-languages/perl/perl.contribution.js"),
    tcl: () => import("monaco-editor/esm/vs/basic-languages/tcl/tcl.contribution.js"),
    ruby: () => import("monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution.js"),
    lua: () => import("monaco-editor/esm/vs/basic-languages/lua/lua.contribution.js"),
    bat: () => import("monaco-editor/esm/vs/basic-languages/bat/bat.contribution.js"),
    dockerfile: () => import("monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution.js"),
    python: () => import("monaco-editor/esm/vs/basic-languages/python/python.contribution.js"),
};

const loadedLanguages = new Set<string>();

export function ensureEditorLanguageLoaded(language: string | undefined): void {
    if (language == null || loadedLanguages.has(language)) {
        return;
    }
    const loader = EXTENDED_LANGUAGE_LOADERS[language];
    if (loader == null) {
        return;
    }
    loadedLanguages.add(language);
    void loader();
}

function getBaseName(fileName: string): string {
    const normalized = fileName.replace(/\\/g, "/");
    return normalized.split("/").pop()?.toLowerCase() ?? "";
}

function getExtension(baseName: string): string {
    const dotIndex = baseName.lastIndexOf(".");
    if (dotIndex <= 0) {
        return "";
    }
    return baseName.slice(dotIndex);
}

export function resolveEditorLanguage(fileName: string | undefined, extendedSyntaxEnabled: boolean): string | undefined {
    if (fileName == null || fileName.length === 0) {
        return undefined;
    }

    const baseName = getBaseName(fileName);
    if (baseName.length === 0) {
        return undefined;
    }

    if (baseName in FILENAME_LANGUAGE_MAP) {
        return FILENAME_LANGUAGE_MAP[baseName];
    }

    if (!extendedSyntaxEnabled) {
        return undefined;
    }

    const extension = getExtension(baseName);
    if (extension.length > 0 && extension in EXTENSION_LANGUAGE_MAP) {
        return EXTENSION_LANGUAGE_MAP[extension];
    }

    return undefined;
}

export function resolveEditorLanguageFromProps(
    fileName: string | undefined,
    language: string | undefined,
    extendedSyntaxEnabled: boolean
): string | undefined {
    if (language != null && language.length > 0) {
        ensureEditorLanguageLoaded(language);
        return language;
    }
    const resolved = resolveEditorLanguage(fileName, extendedSyntaxEnabled);
    ensureEditorLanguageLoaded(resolved);
    return resolved;
}
