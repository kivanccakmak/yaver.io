package main

import (
	"encoding/json"
	"fmt"
	"strings"
)

func dashIfEmpty(value string) string {
	if strings.TrimSpace(value) == "" {
		return "-"
	}
	return value
}

func yesNo(value bool) string {
	if value {
		return "yes"
	}
	return "no"
}

func boolPtr(value bool) *bool { return &value }

func cleanProjectList(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		key := strings.ToLower(value)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, value)
	}
	return out
}

func prettyPrintJSONObject(value map[string]any) {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		fmt.Println(value)
		return
	}
	fmt.Println(string(data))
}
