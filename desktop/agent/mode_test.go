package main

import (
	"reflect"
	"testing"
)

func TestApplyModeArgs(t *testing.T) {
	tests := []struct {
		name   string
		runner RunnerConfig
		mode   string
		args   []string
		want   []string
	}{
		{
			name:   "opencode build",
			runner: RunnerConfig{RunnerID: "opencode", Args: []string{"run", "{prompt}"}},
			mode:   "build",
			args:   []string{"run", "{prompt}"},
			want:   []string{"run", "--agent", "build", "{prompt}"},
		},
		{
			name:   "opencode plan",
			runner: RunnerConfig{RunnerID: "opencode", Args: []string{"run", "{prompt}"}},
			mode:   "plan",
			args:   []string{"run", "{prompt}"},
			want:   []string{"run", "--agent", "plan", "{prompt}"},
		},
		{
			name:   "opencode custom agent",
			runner: RunnerConfig{RunnerID: "opencode", Args: []string{"run", "{prompt}"}},
			mode:   "my-agent",
			args:   []string{"run", "{prompt}"},
			want:   []string{"run", "--agent", "my-agent", "{prompt}"},
		},
		{
			name:   "empty mode leaves args unchanged",
			runner: RunnerConfig{RunnerID: "opencode", Args: []string{"run", "{prompt}"}},
			mode:   "",
			args:   []string{"run", "{prompt}"},
			want:   []string{"run", "{prompt}"},
		},
		{
			name:   "non-opencode runner ignores mode",
			runner: RunnerConfig{RunnerID: "claude", Args: []string{"-p", "{prompt}"}},
			mode:   "plan",
			args:   []string{"-p", "{prompt}"},
			want:   []string{"-p", "{prompt}"},
		},
		{
			name:   "opencode args without run subcommand",
			runner: RunnerConfig{RunnerID: "opencode", Args: []string{"{prompt}"}},
			mode:   "build",
			args:   []string{"{prompt}"},
			want:   []string{"--agent", "build", "{prompt}"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := applyModeArgs(tt.runner, tt.mode, append([]string(nil), tt.args...))
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("applyModeArgs(%s, %q) = %v, want %v", tt.runner.RunnerID, tt.mode, got, tt.want)
			}
		})
	}
}
