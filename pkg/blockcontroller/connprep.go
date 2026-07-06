// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package blockcontroller

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/remote/conncontroller"
)

// prepareShellConnection ensures an SSH connection is ready for shell startup and
// triggers conn:prescript for each shell start. WSL/local connections are skipped.
// Returns (prescriptErr, err) where err is fatal and prescriptErr is non-fatal.
func prepareShellConnection(ctx context.Context, connName string) (error, error) {
	if connName == "" || conncontroller.IsLocalConnName(connName) || conncontroller.IsWslConnName(connName) {
		return nil, nil
	}
	if err := conncontroller.EnsureConnection(ctx, connName); err != nil {
		return nil, err
	}
	return conncontroller.RunConnectionPreScriptForShell(ctx, connName), nil
}
