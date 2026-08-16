//go:build windows

package main

import "fmt"

func redroidFreeBytes(path string) (uint64, error) {
	return 0, fmt.Errorf("redroid disk probe is only available on Linux hosts, not Windows")
}
