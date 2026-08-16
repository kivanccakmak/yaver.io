package main

// vibeRegistry owns internal dev-server resource attribution. Co-vibe's
// participant/join HTTP API was removed; the registry remains an implementation
// detail so concurrent owner workloads still receive distinct ports/devices.
func (s *HTTPServer) vibeRegistry() *VibeSessionRegistry {
	s.vibeOnce.Do(func() {
		s.vibeSessions = NewVibeSessionRegistry(s.ownerUserID)
		registerVibeRegistry(s.vibeSessions)
	})
	return s.vibeSessions
}
