// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/util/shellutil"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

var tokenCmd = &cobra.Command{
	Use:   "token [token] [shell-type]",
	Short: "exchange token for shell initialization script",
	Long: `Exchange a swap token for the shell initialization script.

Two forms are supported:
  wsh token <shell-type>              reads token from WAVETERM_SWAPTOKEN env var (preferred for csh/tcsh)
  wsh token <token> <shell-type>      uses the token provided as the first argument`,
	RunE:   tokenCmdRun,
	Hidden: true,
}

func init() {
	rootCmd.AddCommand(tokenCmd)
}

func tokenCmdRun(cmd *cobra.Command, args []string) (rtnErr error) {
	var tokenStr, shellType string
	if len(args) == 1 {
		shellType = args[0]
		tokenStr = os.Getenv(wavebase.WaveSwapTokenVarName)
		if tokenStr == "" {
			return fmt.Errorf("wsh token: shell-type-only form requires %s env var to be set", wavebase.WaveSwapTokenVarName)
		}
	} else if len(args) == 2 {
		tokenStr, shellType = args[0], args[1]
		if tokenStr == "" || shellType == "" {
			OutputHelpMessage(cmd)
			return fmt.Errorf("wsh token requires non-empty arguments")
		}
	} else {
		OutputHelpMessage(cmd)
		return fmt.Errorf("wsh token requires 1 or 2 arguments, got %d", len(args))
	}
	rtnData, err := setupRpcClientWithToken(tokenStr)
	if err != nil {
		return fmt.Errorf("error setting up rpc client: %w", err)
	}
	envScriptText, err := shellutil.EncodeEnvVarsForShell(shellType, rtnData.Env)
	if err != nil {
		return fmt.Errorf("error encoding env vars: %w", err)
	}
	WriteStdout("%s\n", envScriptText)
	WriteStdout("%s\n", rtnData.InitScriptText)
	return nil
}
