//go:build !windows
// +build !windows

package main

// windows_seat_stub.go — the non-Windows twin of windows_seat.go.
//
// On Unix the tmux server (or the WSL shim on a Unix-like layer) is the seat
// holder, so the shared index remains dormant. Its implementation is in a
// platform-neutral file so CI can still verify the Windows seat contract.

// platform hooks — the non-Windows side: no in-process seat layer, so every
// hook reports the "absent" answer (tmux is the persistence mechanism there).

func platformWindowsSeatsEnabled(s *HTTPServer) bool { return false }

func platformWindowsSeatResume(s *HTTPServer, seatName string) string { return "" }

func platformWindowsSeatClaim(s *HTTPServer, seatName, sessionID string) string { return "" }

func platformWindowsSeatRelease(s *HTTPServer, sessionID string) {}
