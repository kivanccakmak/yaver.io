//go:build !windows
// +build !windows

package main

// windows_seat_stub.go — the non-Windows twin of windows_seat.go.
//
// On Unix the tmux server (or the WSL shim on a Unix-like layer) is the seat
// holder, so there is no in-process seat index: the shared HTTPServer field
// and the NewHTTPServer constructor reference windowsSeatIndex /
// newWindowsSeatIndex, and this file gives those references a nil-safe home
// so the shared code compiles on every platform. All methods are no-ops; any
// accidental call returns the "free seat" answer rather than panicking on a
// nil map.
type windowsSeatIndex struct{}

func newWindowsSeatIndex() *windowsSeatIndex { return &windowsSeatIndex{} }

func (w *windowsSeatIndex) register(seatName, sessionID string) (previous string) { return "" }
func (w *windowsSeatIndex) lookup(seatName string) string                        { return "" }
func (w *windowsSeatIndex) release(sessionID string)                             {}
func (w *windowsSeatIndex) seatNameFor(sessionID string) string                  { return "" }

// platform hooks — the non-Windows side: no in-process seat layer, so every
// hook reports the "absent" answer (tmux is the persistence mechanism there).

func platformWindowsSeatsEnabled(s *HTTPServer) bool { return false }

func platformWindowsSeatResume(s *HTTPServer, seatName string) string { return "" }

func platformWindowsSeatClaim(s *HTTPServer, seatName, sessionID string) string { return "" }

func platformWindowsSeatRelease(s *HTTPServer, sessionID string) {}
