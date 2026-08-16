//go:build !windows

package main

import (
	"os"
	"strings"
	"syscall"
)

func redroidFreeBytes(path string) (uint64, error) {
	if strings.TrimSpace(path) == "" {
		path = "/"
	}
	if _, err := os.Stat(path); err != nil {
		path = "/"
	}
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, err
	}
	return st.Bavail * uint64(st.Bsize), nil
}
