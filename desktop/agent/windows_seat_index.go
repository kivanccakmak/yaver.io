package main

// windowsSeatIndex is platform-neutral bookkeeping for native Windows seats.
// Keeping the map itself free of build tags lets every CI host verify the
// persistence/reattach contract; only the hooks that activate it are
// platform-specific.

import "sync"

type windowsSeatIndex struct {
	mu     sync.Mutex
	byName map[string]string // seat name → terminal session id
	bySess map[string]string // terminal session id → seat name
}

func newWindowsSeatIndex() *windowsSeatIndex {
	return &windowsSeatIndex{
		byName: make(map[string]string),
		bySess: make(map[string]string),
	}
}

// register claims seatName for sessionID and returns the previous holder.
func (w *windowsSeatIndex) register(seatName, sessionID string) (previous string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	previous = w.byName[seatName]
	if previous != "" && previous != sessionID {
		delete(w.bySess, previous)
	}
	w.byName[seatName] = sessionID
	w.bySess[sessionID] = seatName
	return previous
}

func (w *windowsSeatIndex) lookup(seatName string) string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.byName[seatName]
}

// release only drops the name when sessionID is still its current holder.
func (w *windowsSeatIndex) release(sessionID string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	name := w.bySess[sessionID]
	if name == "" {
		return
	}
	if w.byName[name] == sessionID {
		delete(w.byName, name)
	}
	delete(w.bySess, sessionID)
}

func (w *windowsSeatIndex) seatNameFor(sessionID string) string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.bySess[sessionID]
}
