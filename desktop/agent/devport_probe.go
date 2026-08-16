package main

import (
	"fmt"
	"net"
	"strings"
	"time"
)

// portBusy reports whether this port is unusable for a dev server. It checks
// both connectability and wildcard binding because either probe alone can
// produce a false green across IPv4/IPv6 listener combinations.
func portBusy(port int) bool {
	for _, addr := range []string{
		fmt.Sprintf("127.0.0.1:%d", port),
		fmt.Sprintf("[::1]:%d", port),
	} {
		if conn, err := net.DialTimeout("tcp", addr, 200*time.Millisecond); err == nil {
			_ = conn.Close()
			return true
		}
	}
	for _, network := range []string{"tcp4", "tcp6"} {
		l, err := net.Listen(network, fmt.Sprintf(":%d", port))
		if err != nil {
			if isUnsupportedNetwork(err) {
				continue
			}
			return true
		}
		_ = l.Close()
	}
	return false
}

func isUnsupportedNetwork(err error) bool {
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "address family not supported") ||
		strings.Contains(msg, "protocol not supported") ||
		strings.Contains(msg, "cannot assign requested address")
}

// portBindFailure classifies the common framework-specific forms of a
// port-already-bound error so the surface names the real cause immediately.
func portBindFailure(tail string) bool {
	if tail == "" {
		return false
	}
	lower := strings.ToLower(tail)
	for _, needle := range []string{
		"address already in use",
		"eaddrinuse",
		"failed to bind",
		"port is already in use",
		"address in use",
	} {
		if strings.Contains(lower, needle) {
			return true
		}
	}
	return false
}
