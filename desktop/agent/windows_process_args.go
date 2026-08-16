package main

import (
	"fmt"
	"sort"
	"strings"
	"unicode/utf16"
)

// buildWindowsCommandLine quotes argv using CommandLineToArgvW-compatible
// rules. It is platform-neutral so Linux/macOS CI can verify native Windows
// process startup without pretending a cross-compile executed it.
func buildWindowsCommandLine(args []string) string {
	quoted := make([]string, len(args))
	for i, arg := range args {
		quoted[i] = quoteWindowsArg(arg)
	}
	return strings.Join(quoted, " ")
}

func quoteWindowsArg(arg string) string {
	if arg == "" {
		return `""`
	}
	if !strings.ContainsAny(arg, " \t\"&()") {
		return arg
	}

	var b strings.Builder
	b.WriteByte('"')
	backslashes := 0
	for _, r := range arg {
		switch r {
		case '\\':
			backslashes++
		case '"':
			b.WriteString(strings.Repeat("\\", backslashes*2+1))
			b.WriteRune(r)
			backslashes = 0
		default:
			b.WriteString(strings.Repeat("\\", backslashes))
			backslashes = 0
			b.WriteRune(r)
		}
	}
	b.WriteString(strings.Repeat("\\", backslashes*2))
	b.WriteByte('"')
	return b.String()
}

// buildWindowsEnvBlock returns the UTF-16, double-NUL-terminated environment
// block required by CreateProcessW. UTF16PtrFromString cannot be used here:
// its embedded-NUL rejection is correct for one string but makes every real
// environment block fail.
func buildWindowsEnvBlock(env []string) ([]uint16, error) {
	ordered := append([]string(nil), env...)
	sort.SliceStable(ordered, func(i, j int) bool {
		return strings.ToUpper(ordered[i]) < strings.ToUpper(ordered[j])
	})

	block := make([]uint16, 0)
	for _, entry := range ordered {
		if strings.IndexByte(entry, 0) >= 0 {
			return nil, fmt.Errorf("windows environment entry contains NUL")
		}
		block = append(block, utf16.Encode([]rune(entry))...)
		block = append(block, 0)
	}
	// CreateProcessW requires an extra terminator after the final entry. For
	// an empty explicit environment it still requires two NUL code units.
	block = append(block, 0)
	if len(ordered) == 0 {
		block = append(block, 0)
	}
	return block, nil
}
