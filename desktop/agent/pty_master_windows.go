//go:build windows
// +build windows

package main

// pty_master_windows.go — the native-Windows implementation of ptyMaster,
// backed by the Windows Pseudo Console (ConPTY) API.
//
// This is the real tmux replacement on native Windows (2026-08-12):
//
//	creack/pty — the PTY library terminal_session.go and install_registry.go
//	call — returns ErrUnsupported on GOOS=windows (verified in its
//	start_windows.go), so even the non-tmux runner path could not spawn a TUI
//	on Windows. tmux itself is a Unix program; the WSL shim (tmux.go) bridged
//	it but demanded WSL2 + a Linux tmux install. This file makes the agent
//	spawn a real console for the child with NO external dependency: ConPTY is
//	the OS-native pseudo-terminal (Windows 10 1809+ / Server 2019+).
//
// HOW IT WORKS:
//	1. Two anonymous pipes: inPipe (child stdin) and outPipe (child stdout).
//	2. CreatePseudoConsole binds the console to inPipe's READ end and
//	   outPipe's WRITE end.
//	3. The child is spawned with STARTUPINFOEX carrying the pseudoconsole
//	   handle in PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE; the child's std handles
//	   are its own pipe ends.
//	4. The master side keeps inPipe's WRITE end (write child input) and
//	   outPipe's READ end (read child output) — the two handles ptyMaster
//	   hides behind one ReadWriteCloser.
//
// ConPTY details worth keeping straight:
//   - The console itself (HPCON) must be closed with ClosePseudoConsole, not
//     just the pipe handles, or the child keeps a stale console reference.
//   - Resize goes through ResizePseudoConsole(HPCON), not the pipes.
//   - The pseudoconsole attribute list must outlive the CreateProcess call.
//   - Only ONE process may be attached to a ConPTY at a time; if the child
//     spawns grandchildren they must inherit the console via the parent, which
//     is exactly how the runner TUI behaves (a single TUI process per seat).

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

// conptyMaster is the Windows ptyMaster: a ConPTY console with separate
// input (write) and output (read) handles, a resize path through the HPCON,
// and an explicit ClosePseudoConsole.
type conptyMaster struct {
	pc        windows.Handle // the HPCON — resize + close go through this
	inW       *os.File       // write child stdin here
	outR      *os.File       // read child stdout here
	cmd       *exec.Cmd
	closeOnce sync.Once
}

func (m *conptyMaster) Read(p []byte) (int, error) {
	if m.outR == nil {
		return 0, errors.New("conpty: output pipe closed")
	}
	return m.outR.Read(p)
}

func (m *conptyMaster) Write(p []byte) (int, error) {
	if m.inW == nil {
		return 0, errors.New("conpty: input pipe closed")
	}
	return m.inW.Write(p)
}

func (m *conptyMaster) Resize(cols, rows uint16) error {
	if m.pc == 0 {
		return nil // never created (Close already ran) — best-effort
	}
	return windows.ResizePseudoConsole(m.pc, windows.Coord{X: int16(cols), Y: int16(rows)})
}

func (m *conptyMaster) Close() error {
	var first error
	m.closeOnce.Do(func() {
		// Order matters: close the pipe ends we own first so a blocked Read
		// unblocks, then close the console, then reap the child (best-effort;
		// the caller may have its own Wait).
		if m.inW != nil {
			if err := m.inW.Close(); err != nil {
				first = err
			}
			m.inW = nil
		}
		if m.outR != nil {
			if err := m.outR.Close(); err != nil {
				first = err
			}
			m.outR = nil
		}
		if m.pc != 0 {
			windows.ClosePseudoConsole(m.pc)
			m.pc = 0
		}
		if m.cmd != nil && m.cmd.Process != nil {
			_ = m.cmd.Process.Kill()
		}
	})
	return first
}

// platformPTYStart spawns cmd attached to a fresh ConPTY and returns the
// master. Mirrors creack/pty's pty.Start contract: on success the child is
// already running and the returned master is how the caller reads/writes its
// terminal.
func platformPTYStart(cmd *exec.Cmd) (ptyMaster, error) {
	if cmd == nil {
		return nil, errors.New("conpty: nil command")
	}

	// Anonymous pipes: inPipe feeds child stdin, outPipe drains child stdout.
	inR, inW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		inR.Close()
		inW.Close()
		return nil, err
	}

	// CreatePseudoConsole takes the READ end of the input pipe and the WRITE
	// end of the output pipe. The master keeps inW (write) and outR (read).
	const defaultCols, defaultRows = 120, 30
	var pc windows.Handle
	if err := windows.CreatePseudoConsole(windows.Coord{X: defaultCols, Y: defaultRows},
		windows.Handle(inR.Fd()), windows.Handle(outW.Fd()), 0, &pc); err != nil {
		inR.Close()
		inW.Close()
		outR.Close()
		outW.Close()
		return nil, err
	}

	// The child inherits the console through STARTUPINFOEX.
	attrList, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		windows.ClosePseudoConsole(pc)
		inR.Close()
		inW.Close()
		outR.Close()
		outW.Close()
		return nil, err
	}
	defer attrList.Delete()

	if err := attrList.Update(windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, unsafe.Pointer(pc), unsafe.Sizeof(pc)); err != nil {
		windows.ClosePseudoConsole(pc)
		inR.Close()
		inW.Close()
		outR.Close()
		outW.Close()
		return nil, err
	}

	// Build the command line. os/exec on Windows builds its own CreateProcess;
	// to pass the pseudoconsole attribute we must construct the process
	// ourselves with StartupInfoEx. Handle the common cases os/exec would
	// (PATH resolution, quoting) via exec.Command's own resolution, then
	// create with CreateProcess.
	exe, err := exec.LookPath(cmd.Path)
	if err != nil {
		// Fall back to the raw path — LookPath fails for explicit .exe paths
		// with no directory that resolve through the CWD.
		exe = cmd.Path
	}
	argv0, err := windows.UTF16PtrFromString(exe)
	if err != nil {
		windows.ClosePseudoConsole(pc)
		inR.Close()
		inW.Close()
		outR.Close()
		outW.Close()
		return nil, err
	}
	// Build a quoted command line from args (os/exec's own quoting rules).
	args := []string{exe}
	if len(cmd.Args) > 1 {
		args = append(args, cmd.Args[1:]...)
	}
	cmdLine, err := windows.UTF16PtrFromString(buildWindowsCommandLine(args))
	if err != nil {
		windows.ClosePseudoConsole(pc)
		inR.Close()
		inW.Close()
		outR.Close()
		outW.Close()
		return nil, err
	}

	// Environment: cmd.Env may be nil (inherit) or a full list.
	var envStorage []uint16
	var envBlock *uint16
	if len(cmd.Env) > 0 {
		envStorage, err = buildWindowsEnvBlock(cmd.Env)
		if err != nil {
			windows.ClosePseudoConsole(pc)
			inR.Close()
			inW.Close()
			outR.Close()
			outW.Close()
			return nil, err
		}
		envBlock = &envStorage[0]
	}

	// Working directory.
	var dirPtr *uint16
	if cmd.Dir != "" {
		dirPtr, err = windows.UTF16PtrFromString(cmd.Dir)
		if err != nil {
			windows.ClosePseudoConsole(pc)
			inR.Close()
			inW.Close()
			outR.Close()
			outW.Close()
			return nil, err
		}
	}

	// StartupInfoEx: EXTENDED_STARTUPINFO_PRESENT + the pseudoconsole attr.
	si := &windows.StartupInfoEx{}
	si.Cb = uint32(unsafe.Sizeof(*si))
	si.ProcThreadAttributeList = attrList.List()
	pi := &windows.ProcessInformation{}

	// EXTENDED_STARTUPINFO_PRESENT is what makes CreateProcessW consume the
	// pseudoconsole attribute. Without it the call can succeed while the child
	// never attaches to ConPTY. CREATE_UNICODE_ENVIRONMENT matches envBlock.
	creationFlags := uint32(windows.EXTENDED_STARTUPINFO_PRESENT | windows.CREATE_UNICODE_ENVIRONMENT)

	if err := windows.CreateProcess(
		argv0, cmdLine, nil, nil, false, creationFlags,
		envBlock, dirPtr, &si.StartupInfo, pi,
	); err != nil {
		windows.ClosePseudoConsole(pc)
		inR.Close()
		inW.Close()
		outR.Close()
		outW.Close()
		return nil, err
	}

	// Close the child-side pipe ends we no longer need (they are duplicated
	// into the child; keeping ours open would hold the pipes open forever).
	inR.Close()
	outW.Close()

	windows.CloseHandle(pi.Thread)
	// A hand-written os.Process{Pid: ...} is invalid on Windows: os.Process
	// also needs its own process HANDLE for Wait/Kill. FindProcess opens that
	// handle; the raw CreateProcess handle can then be closed without leaking.
	proc, err := os.FindProcess(int(pi.ProcessId))
	if err != nil {
		_ = windows.TerminateProcess(pi.Process, 1)
		windows.CloseHandle(pi.Process)
		windows.ClosePseudoConsole(pc)
		inW.Close()
		outR.Close()
		return nil, fmt.Errorf("conpty: open child process handle: %w", err)
	}
	windows.CloseHandle(pi.Process)
	cmd.Process = proc

	return &conptyMaster{pc: pc, inW: inW, outR: outR, cmd: cmd}, nil
}

// Ensure io is imported for the interface satisfaction check on non-windows
// builds via the shared pty_master.go; keep this reference explicit so the
// compiler never reports it unused on future refactors.
var _ io.ReadWriteCloser = (*conptyMaster)(nil)

// newUnixPTYMaster exists so the shared newTerminalSessionFromPTY compiles on
// Windows. It is never reached with a real FD there (the privilege-separated
// helper is Unix-only; helperTenantShellFD returns an error on Windows, so
// console_terminal.go falls through to the sudo path). If it somehow were
// called, the adapter still works — osFilePTYMaster's Resize is a no-op with
// a nil resizer, and Read/Write/Close delegate to the file.
func newUnixPTYMaster(f *os.File) *osFilePTYMaster {
	return &osFilePTYMaster{File: f}
}
