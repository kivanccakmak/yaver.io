package main

import (
	"reflect"
	"testing"
)

func TestReleaseCLIUsesProtectedWorkflowDispatch(t *testing.T) {
	want := []string{"gh", "workflow", "run", "release-cli.yml", "--ref", "main", "-f", "publish_npm=true"}
	if got := releaseCLIWorkflowArgs(); !reflect.DeepEqual(got, want) {
		t.Fatalf("release dispatch = %q, want %q", got, want)
	}
}
