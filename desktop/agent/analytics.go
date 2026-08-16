package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Analytics tracks local usage statistics.
type Analytics struct {
	mu        sync.RWMutex
	data      AnalyticsData
	storePath string
}

type AnalyticsData struct {
	// Lifetime stats
	TotalTasks        int     `json:"totalTasks"`
	CompletedTasks    int     `json:"completedTasks"`
	FailedTasks       int     `json:"failedTasks"`
	TotalCostUSD      float64 `json:"totalCostUsd"`
	TotalDurationMs   int64   `json:"totalDurationMs"`
	TotalTurns        int     `json:"totalTurns"`
	TotalExecCommands int     `json:"totalExecCommands"`
	TotalTransfers    int     `json:"totalTransfers"`

	// Per-runner stats
	RunnerStats map[string]*RunnerStats `json:"runnerStats"`

	// Daily stats (last 90 days)
	DailyStats map[string]*DayStats `json:"dailyStats"` // key: "2026-03-22"

	// Per-model costs
	ModelCosts map[string]float64 `json:"modelCosts"` // key: model name

	// First/last activity
	FirstTaskAt string `json:"firstTaskAt,omitempty"`
	LastTaskAt  string `json:"lastTaskAt,omitempty"`
}

type RunnerStats struct {
	Tasks     int     `json:"tasks"`
	Completed int     `json:"completed"`
	Failed    int     `json:"failed"`
	CostUSD   float64 `json:"costUsd"`
	AvgDurMs  int64   `json:"avgDurationMs"`
}

type DayStats struct {
	Tasks     int     `json:"tasks"`
	Completed int     `json:"completed"`
	Failed    int     `json:"failed"`
	CostUSD   float64 `json:"costUsd"`
	ExecCmds  int     `json:"execCmds"`
	Transfers int     `json:"transfers"`
}

// NewAnalytics creates an analytics tracker that persists to ~/.yaver/analytics.json.
func NewAnalytics() *Analytics {
	dir, _ := ConfigDir()
	a := &Analytics{
		storePath: filepath.Join(dir, "analytics.json"),
		data: AnalyticsData{
			RunnerStats: make(map[string]*RunnerStats),
			DailyStats:  make(map[string]*DayStats),
			ModelCosts:  make(map[string]float64),
		},
	}
	a.load()
	return a
}

// RecordTask records a completed task.
func (a *Analytics) RecordTask(runnerID, model, status string, costUSD float64, durationMs int64, turns int) {
	a.mu.Lock()
	defer a.mu.Unlock()

	a.data.TotalTasks++
	a.data.TotalCostUSD += costUSD
	a.data.TotalDurationMs += durationMs
	a.data.TotalTurns += turns

	now := time.Now().UTC().Format(time.RFC3339)
	if a.data.FirstTaskAt == "" {
		a.data.FirstTaskAt = now
	}
	a.data.LastTaskAt = now

	if status == "completed" {
		a.data.CompletedTasks++
	} else if status == "failed" {
		a.data.FailedTasks++
	}

	// Runner stats
	rs, ok := a.data.RunnerStats[runnerID]
	if !ok {
		rs = &RunnerStats{}
		a.data.RunnerStats[runnerID] = rs
	}
	rs.Tasks++
	if status == "completed" {
		rs.Completed++
	} else if status == "failed" {
		rs.Failed++
	}
	rs.CostUSD += costUSD
	if rs.Tasks > 0 {
		rs.AvgDurMs = (rs.AvgDurMs*int64(rs.Tasks-1) + durationMs) / int64(rs.Tasks)
	}

	// Model costs
	if model != "" && costUSD > 0 {
		a.data.ModelCosts[model] += costUSD
	}

	// Daily stats
	day := time.Now().Format("2006-01-02")
	ds, ok := a.data.DailyStats[day]
	if !ok {
		ds = &DayStats{}
		a.data.DailyStats[day] = ds
	}
	ds.Tasks++
	if status == "completed" {
		ds.Completed++
	} else if status == "failed" {
		ds.Failed++
	}
	ds.CostUSD += costUSD

	a.cleanOldDays()
	a.save()
}

// RecordExec records an exec command.
func (a *Analytics) RecordExec() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.data.TotalExecCommands++
	day := time.Now().Format("2006-01-02")
	ds, ok := a.data.DailyStats[day]
	if !ok {
		ds = &DayStats{}
		a.data.DailyStats[day] = ds
	}
	ds.ExecCmds++
	a.save()
}

// RecordTransfer records a session transfer.
func (a *Analytics) RecordTransfer() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.data.TotalTransfers++
	day := time.Now().Format("2006-01-02")
	ds, ok := a.data.DailyStats[day]
	if !ok {
		ds = &DayStats{}
		a.data.DailyStats[day] = ds
	}
	ds.Transfers++
	a.save()
}

// GetStats returns the current analytics data.
func (a *Analytics) GetStats() AnalyticsData {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.data
}

// GetSummary returns a human-readable summary.
func (a *Analytics) GetSummary() string {
	a.mu.RLock()
	defer a.mu.RUnlock()

	successRate := 0.0
	if a.data.TotalTasks > 0 {
		successRate = float64(a.data.CompletedTasks) / float64(a.data.TotalTasks) * 100
	}

	summary := fmt.Sprintf("Usage Analytics\n\n")
	summary += fmt.Sprintf("Tasks: %d total (%d completed, %d failed) — %.1f%% success rate\n",
		a.data.TotalTasks, a.data.CompletedTasks, a.data.FailedTasks, successRate)
	summary += fmt.Sprintf("Total cost: $%.4f\n", a.data.TotalCostUSD)
	summary += fmt.Sprintf("Exec commands: %d\n", a.data.TotalExecCommands)
	summary += fmt.Sprintf("Session transfers: %d\n", a.data.TotalTransfers)

	if len(a.data.RunnerStats) > 0 {
		summary += "\nPer runner:\n"
		for id, rs := range a.data.RunnerStats {
			summary += fmt.Sprintf("  %s: %d tasks, $%.4f, avg %dms\n",
				id, rs.Tasks, rs.CostUSD, rs.AvgDurMs)
		}
	}

	if len(a.data.ModelCosts) > 0 {
		summary += "\nPer model:\n"
		for model, cost := range a.data.ModelCosts {
			summary += fmt.Sprintf("  %s: $%.4f\n", model, cost)
		}
	}

	return summary
}

func (a *Analytics) cleanOldDays() {
	cutoff := time.Now().AddDate(0, 0, -90).Format("2006-01-02")
	for day := range a.data.DailyStats {
		if day < cutoff {
			delete(a.data.DailyStats, day)
		}
	}
}

func (a *Analytics) save() {
	data, _ := json.MarshalIndent(a.data, "", "  ")
	os.WriteFile(a.storePath, data, 0600)
}

func (a *Analytics) load() {
	data, err := os.ReadFile(a.storePath)
	if err != nil {
		return
	}
	json.Unmarshal(data, &a.data)
	if a.data.RunnerStats == nil {
		a.data.RunnerStats = make(map[string]*RunnerStats)
	}
	if a.data.DailyStats == nil {
		a.data.DailyStats = make(map[string]*DayStats)
	}
	if a.data.ModelCosts == nil {
		a.data.ModelCosts = make(map[string]float64)
	}
}
