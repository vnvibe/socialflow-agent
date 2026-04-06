//go:build !windows

package main

import "os/exec"

func hideConsole(cmd *exec.Cmd) {
	// No-op on non-Windows
}
