// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package shellutil

import "testing"

func TestGetShellTypeFromShellPath(t *testing.T) {
    tests := []struct {
        path string
        want string
    }{
        {path: "/bin/bash", want: ShellType_bash},
        {path: "/usr/local/bin/zsh", want: ShellType_zsh},
        {path: "/opt/homebrew/bin/fish", want: ShellType_fish},
        {path: "/usr/bin/pwsh", want: ShellType_pwsh},
        {path: "/usr/bin/powershell", want: ShellType_pwsh},
        {path: "/bin/csh", want: ShellType_csh},
        {path: "/bin/tcsh", want: ShellType_tcsh},
        {path: "/bin/unknown", want: ShellType_unknown},
    }

    for _, test := range tests {
        got := GetShellTypeFromShellPath(test.path)
        if got != test.want {
            t.Fatalf("GetShellTypeFromShellPath(%q) = %q, want %q", test.path, got, test.want)
        }
    }
}

func TestEncodeEnvVarsForCsh(t *testing.T) {
    env := map[string]string{
        "WAVETERM_BLOCKID": "block-123",
        "WAVETERM_SPACE":   "value with spaces",
    }

    script, err := EncodeEnvVarsForShell(ShellType_csh, env)
    if err != nil {
        t.Fatalf("EncodeEnvVarsForShell(csh) returned error: %v", err)
    }

    if script == "" {
        t.Fatalf("EncodeEnvVarsForShell(csh) returned empty script")
    }

    if !(containsLine(script, "setenv WAVETERM_BLOCKID block-123") || containsLine(script, "setenv WAVETERM_BLOCKID \"block-123\"")) {
        t.Fatalf("missing expected WAVETERM_BLOCKID line in script: %q", script)
    }

    if !containsLine(script, "setenv WAVETERM_SPACE \"value with spaces\"") {
        t.Fatalf("missing expected WAVETERM_SPACE line in script: %q", script)
    }
}

func TestEncodeEnvVarsForTcsh(t *testing.T) {
    env := map[string]string{
        "WAVETERM_SHELL": "tcsh",
    }

    script, err := EncodeEnvVarsForShell(ShellType_tcsh, env)
    if err != nil {
        t.Fatalf("EncodeEnvVarsForShell(tcsh) returned error: %v", err)
    }

    if !containsLine(script, "setenv WAVETERM_SHELL tcsh") {
        t.Fatalf("missing expected tcsh export line in script: %q", script)
    }
}

func containsLine(script string, line string) bool {
    return script == line+"\n" ||
        len(script) > len(line)+1 &&
            (script[:len(line)+1] == line+"\n" ||
                script[len(script)-len(line)-1:] == line+"\n") ||
        containsSubstring(script, "\n"+line+"\n")
}

func containsSubstring(s string, sub string) bool {
    if len(sub) == 0 {
        return true
    }
    if len(sub) > len(s) {
        return false
    }
    for i := 0; i <= len(s)-len(sub); i++ {
        if s[i:i+len(sub)] == sub {
            return true
        }
    }
    return false
}
