//go:build !windows
// +build !windows

package main

// pty_master_unix.go — the creack/pty-backed implementation of ptyMaster for
// every non-Windows platform. This is the byte-for-byte behaviour the agent
// shipped before the abstraction: pty.Start spawns the command on a real
// pseudo-terminal and returns the master file; Resize forwards to
// pty.Setsize. No behavioural change — the abstraction only exists so the
// Windows build can substitute ConPTY behind the same interface.

import (
	"os"
	"os/exec"

	"github.com/creack/pty"
)

// unixPTYMaster adapts creack/pty's *os.File master to ptyMaster. The
// resizer routes through pty.Setsize; construction of the adapter type is
// handled by osFilePTYMaster in pty_master.go, wired here so the shared
// adapter keeps its Resize channel.
type unixPTYMaster = osFilePTYMaster

func newUnixPTYMaster(f *os.File) *osFilePTYMaster {
	return &osFilePTYMaster{
		File: f,
		resizer: func(file *os.File, cols, rows uint16) error {
			return pty.Setsize(file, &pty.Winsize{Cols: cols, Rows: rows})
		},
	}
}

func platformPTYStart(cmd *exec.Cmd) (ptyMaster, error) {
	ptmx, err := pty.Start(cmd)
	if err != nil {
		return nil, err
	}
	return newUnixPTYMaster(ptmx), nil
}
