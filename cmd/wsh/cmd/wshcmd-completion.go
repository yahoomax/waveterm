// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
    "fmt"
    "sort"
    "strings"

    "github.com/spf13/cobra"
)

var completionCmd = &cobra.Command{
    Use:                  "completion [shell]",
    Hidden:               true,
    DisableFlagsInUseLine: true,
    Args:                 cobra.ExactArgs(1),
    RunE:                 completionCmdRun,
}

var completionSubcommandsCmd = &cobra.Command{
    Use:                   "__complete_subcommands [command]",
    Hidden:                true,
    DisableFlagsInUseLine: true,
    Args:                  cobra.ExactArgs(1),
    RunE:                  completionSubcommandsCmdRun,
}

func init() {
    rootCmd.CompletionOptions.DisableDefaultCmd = true
    rootCmd.AddCommand(completionCmd)
    rootCmd.AddCommand(completionSubcommandsCmd)
}

func completionCmdRun(cmd *cobra.Command, args []string) error {
    shellName := strings.ToLower(strings.TrimSpace(args[0]))
    switch shellName {
    case "bash":
        return rootCmd.GenBashCompletion(WrappedStdout)
    case "zsh":
        return rootCmd.GenZshCompletion(WrappedStdout)
    case "fish":
        return rootCmd.GenFishCompletion(WrappedStdout, true)
    case "powershell", "pwsh":
        return rootCmd.GenPowerShellCompletionWithDesc(WrappedStdout)
    case "csh", "tcsh":
        return generateCshCompletion(shellName)
    default:
        return fmt.Errorf("unsupported shell for completion: %s", shellName)
    }
}

func completionSubcommandsCmdRun(cmd *cobra.Command, args []string) error {
    parent := findSubcommand(rootCmd, args[0])
    if parent == nil {
        return nil
    }
    names := listPublicSubcommandNames(parent)
    if len(names) == 0 {
        return nil
    }
    WriteStdout("%s\n", strings.Join(names, " "))
    return nil
}

func generateCshCompletion(shellName string) error {
    top := listPublicSubcommandNames(rootCmd)
    if len(top) == 0 {
        return nil
    }
    WriteStdout("# wsh completion for %s\n", shellName)
    WriteStdout("# tcsh supports the complete builtin; plain csh may ignore these rules.\n")
    WriteStdout("set _wsh_cmds = (%s)\n", strings.Join(top, " "))
    WriteStdout("if ($?tcsh) then\n")
    WriteStdout("    complete wsh 'p/1/($_wsh_cmds)/'\n")
    WriteStdout("    complete wsh 'p/2/(`wsh __complete_subcommands \\!:1`)/'\n")
    WriteStdout("endif\n")
    WriteStdout("unset _wsh_cmds\n")
    return nil
}

func findSubcommand(root *cobra.Command, name string) *cobra.Command {
    for _, child := range root.Commands() {
        if child.Name() == name {
            return child
        }
    }
    return nil
}

func listPublicSubcommandNames(root *cobra.Command) []string {
    names := make([]string, 0)
    for _, child := range root.Commands() {
        if !child.IsAvailableCommand() || child.Hidden {
            continue
        }
        names = append(names, child.Name())
    }
    sort.Strings(names)
    return names
}
