// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package blockcontroller

import (
    "reflect"
    "testing"

    "github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestGetCustomInitScriptKeyCascade(t *testing.T) {
    tests := []struct {
        shellType string
        want      []string
    }{
        {
            shellType: "csh",
            want: []string{waveobj.MetaKey_CmdInitScriptCsh, waveobj.MetaKey_CmdInitScript},
        },
        {
            shellType: "tcsh",
            want: []string{waveobj.MetaKey_CmdInitScriptTcsh, waveobj.MetaKey_CmdInitScriptCsh, waveobj.MetaKey_CmdInitScript},
        },
        {
            shellType: "bash",
            want: []string{waveobj.MetaKey_CmdInitScriptBash, waveobj.MetaKey_CmdInitScriptSh, waveobj.MetaKey_CmdInitScript},
        },
    }

    for _, test := range tests {
        got := getCustomInitScriptKeyCascade(test.shellType)
        if !reflect.DeepEqual(got, test.want) {
            t.Fatalf("getCustomInitScriptKeyCascade(%q) = %v, want %v", test.shellType, got, test.want)
        }
    }
}
