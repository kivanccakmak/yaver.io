package main

// AccessDeniedReason is the structured denial returned by owner, paid-feature,
// SDK runner, and MCP tool policy gates.
type AccessDeniedReason struct {
	Denied bool   `json:"denied"`
	Reason string `json:"reason"`
}
