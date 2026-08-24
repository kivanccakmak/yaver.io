package main

// HTML tag names are ASCII. Searching a strings.ToLower copy and then slicing
// the original is byte-unsafe: Unicode case folding can change byte length
// (Turkish İ did), moving an insertion into the preceding </script> tag.
func indexASCIIFold(s, needle string) int {
	if needle == "" {
		return 0
	}
	for i := 0; i+len(needle) <= len(s); i++ {
		if equalASCIIFold(s[i:i+len(needle)], needle) {
			return i
		}
	}
	return -1
}

func lastIndexASCIIFold(s, needle string) int {
	if needle == "" {
		return len(s)
	}
	for i := len(s) - len(needle); i >= 0; i-- {
		if equalASCIIFold(s[i:i+len(needle)], needle) {
			return i
		}
	}
	return -1
}

func equalASCIIFold(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		aa, bb := a[i], b[i]
		if aa >= 'A' && aa <= 'Z' {
			aa += 'a' - 'A'
		}
		if bb >= 'A' && bb <= 'Z' {
			bb += 'a' - 'A'
		}
		if aa != bb {
			return false
		}
	}
	return true
}
