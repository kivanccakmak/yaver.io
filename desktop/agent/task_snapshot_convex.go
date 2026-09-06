package main

// Privacy-safe task lifecycle snapshot synced to Convex.
//
// Full task records (title, prompt, source, output, paths and transcript) stay
// on the owning machine. Convex receives only enough identity + lifecycle to
// invalidate stale client caches and keep cross-device counts honest.

import (
	"context"
	"encoding/json"
	"sort"
	"sync"
	"time"
)

type convexTaskLifecycle struct {
	TaskID         string `json:"taskId"`
	YaverSessionID string `json:"yaverSessionId,omitempty"`
	Status         string `json:"status"`
	HostKind       string `json:"hostKind,omitempty"`
	UpdatedAt      int64  `json:"updatedAt"`
}

type taskSnapshotSyncState struct {
	mu         sync.Mutex
	lastHash   uint64
	lastSentAt time.Time
	sent       bool
}

type convexTaskLifecycleHash struct {
	TaskID         string `json:"taskId"`
	YaverSessionID string `json:"yaverSessionId,omitempty"`
	Status         string `json:"status"`
	HostKind       string `json:"hostKind,omitempty"`
}

var globalTaskSnapshotSync taskSnapshotSyncState

const taskSnapshotForcedRefreshInterval = 2 * time.Hour
const maxConvexTaskSnapshotRows = 200

func localTaskLifecycleSnapshot(tm *TaskManager) []convexTaskLifecycle {
	if tm == nil {
		return []convexTaskLifecycle{}
	}
	tm.mu.RLock()
	rows := make([]convexTaskLifecycle, 0, len(tm.tasks))
	for _, task := range tm.tasks {
		if task == nil || task.DeletedAt != nil {
			continue
		}
		updated := task.LastActiveAt
		if updated.IsZero() && task.FinishedAt != nil {
			updated = *task.FinishedAt
		}
		if updated.IsZero() {
			updated = task.CreatedAt
		}
		rows = append(rows, convexTaskLifecycle{
			TaskID: task.ID, YaverSessionID: task.YaverSessionID,
			Status: string(task.Status), HostKind: taskHostKind(task), UpdatedAt: updated.UnixMilli(),
		})
	}
	tm.mu.RUnlock()

	sort.Slice(rows, func(i, j int) bool {
		if rows[i].UpdatedAt == rows[j].UpdatedAt {
			return rows[i].TaskID < rows[j].TaskID
		}
		return rows[i].UpdatedAt > rows[j].UpdatedAt
	})
	if len(rows) > maxConvexTaskSnapshotRows {
		rows = rows[:maxConvexTaskSnapshotRows]
	}
	return rows
}

func syncTaskSnapshotToConvex(ctx context.Context, tm *TaskManager) {
	if globalConvexSync == nil || tm == nil {
		return
	}
	rows := localTaskLifecycleSnapshot(tm)
	// LastActiveAt can move for every output chunk. It is useful metadata on a
	// real lifecycle publication, but it must not turn a coding stream into a
	// Convex write stream. Hash identity + status only; a quiet machine gets one
	// two-hour freshness write and state transitions publish immediately.
	hashRows := make([]convexTaskLifecycleHash, 0, len(rows))
	for _, row := range rows {
		hashRows = append(hashRows, convexTaskLifecycleHash{
			TaskID: row.TaskID, YaverSessionID: row.YaverSessionID, Status: row.Status, HostKind: row.HostKind,
		})
	}
	hashPayload, err := json.Marshal(hashRows)
	if err != nil {
		return
	}
	h := hashBytes(hashPayload)

	globalTaskSnapshotSync.mu.Lock()
	unchanged := globalTaskSnapshotSync.sent && h == globalTaskSnapshotSync.lastHash
	fresh := time.Since(globalTaskSnapshotSync.lastSentAt) < taskSnapshotForcedRefreshInterval
	globalTaskSnapshotSync.mu.Unlock()
	if unchanged && fresh {
		return
	}

	// observedAt is deliberately excluded from hashPayload. It refreshes only
	// on a real state change or the two-hour freshness floor, not every minute.
	args := map[string]interface{}{
		"deviceId":   globalConvexSync.deviceID,
		"observedAt": time.Now().UnixMilli(),
		"tasks":      rows,
	}
	if !globalConvexSync.callMutationOK("agentTaskSnapshots:sync", args) {
		return
	}
	globalTaskSnapshotSync.mu.Lock()
	globalTaskSnapshotSync.lastHash = h
	globalTaskSnapshotSync.lastSentAt = time.Now()
	globalTaskSnapshotSync.sent = true
	globalTaskSnapshotSync.mu.Unlock()
}
