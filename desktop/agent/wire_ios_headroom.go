package main

const wireIOSMinFreeBytes = int64(10) << 30 // 10 GiB
const wireIOSAbsoluteMinFreeBytes = int64(2) << 30

func hasWireIOSBuildHeadroom(freeBytes, reusableDerivedBytes int64) bool {
	return freeBytes >= wireIOSAbsoluteMinFreeBytes && freeBytes+reusableDerivedBytes >= wireIOSMinFreeBytes
}
