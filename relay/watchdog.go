package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"os"
	"strconv"
	"strings"
	"time"
)

// systemdWatchdog is dependency-free. Under systemd it sends READY=1 and
// periodic WATCHDOG=1 notifications; outside systemd it is a no-op.
func systemdWatchdog(ctx context.Context) {
	socket := os.Getenv("NOTIFY_SOCKET")
	usec, err := strconv.ParseInt(os.Getenv("WATCHDOG_USEC"), 10, 64)
	if socket == "" || err != nil || usec <= 0 {
		return
	}
	if strings.HasPrefix(socket, "@") {
		socket = "\x00" + socket[1:]
	}
	conn, err := net.DialUnix("unixgram", nil, &net.UnixAddr{Name: socket, Net: "unixgram"})
	if err != nil {
		log.Printf("[RELAY] systemd watchdog unavailable: %v", err)
		return
	}
	defer conn.Close()
	notify := func(message string) {
		if _, err := conn.Write([]byte(message)); err != nil {
			log.Printf("[RELAY] systemd notification failed: %v", err)
		}
	}
	notify(fmt.Sprintf("READY=1\nSTATUS=relay %s running", version))
	interval := time.Duration(usec) * time.Microsecond / 2
	if interval < time.Second {
		interval = time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			notify("STOPPING=1\nSTATUS=shutting down")
			return
		case <-ticker.C:
			notify("WATCHDOG=1")
		}
	}
}
