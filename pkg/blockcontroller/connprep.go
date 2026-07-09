// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package blockcontroller

import (
	"context"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/remote/conncontroller"
)

const preScriptDedupeWindow = 15 * time.Second

var (
	preScriptMu        sync.Mutex
	preScriptLastRun   = make(map[string]time.Time)
)

func shouldRunPreScriptForBlock(blockId string) bool {
	if blockId == "" {
		return true
	}
	now := time.Now()
	preScriptMu.Lock()
	defer preScriptMu.Unlock()
	if lastRun, ok := preScriptLastRun[blockId]; ok && now.Sub(lastRun) < preScriptDedupeWindow {
		return false
	}
	preScriptLastRun[blockId] = now
	return true
}

// prepareShellConnection ensures an SSH connection is ready for shell startup and
// runs conn:prescript once per shell block start. WSL/local connections are skipped.
// Returns (prescriptErr, err) where err is fatal and prescriptErr is non-fatal.
func prepareShellConnection(ctx context.Context, blockId string, connName string) (error, error) {
	if connName == "" || conncontroller.IsLocalConnName(connName) || conncontroller.IsWslConnName(connName) {
		return nil, nil
	}
	if err := conncontroller.EnsureConnection(ctx, connName); err != nil {
		return nil, err
	}
	if !shouldRunPreScriptForBlock(blockId) {
		return nil, nil
	}
	return conncontroller.RunConnectionPreScriptForShell(ctx, connName), nil
}
