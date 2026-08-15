package main

import (
	"net/http"
	"time"
)

// Readiness asks one narrow question: is an HTTP server accepting traffic on
// the dev port? It must not follow application redirects. A Next middleware
// can legitimately redirect `/` to HTTPS, auth, or a locale route; following
// that redirect turns a healthy listener into a failed readiness probe when
// the destination is external or TLS is terminated elsewhere. The old use of
// http.Get followed Yaver web's 308 to https://0.0.0.0:<dev-port>, waited the
// full 120 seconds, then killed a Next process that had printed Ready in 821ms.
var devReadinessHTTPClient = &http.Client{
	Timeout: 3 * time.Second,
	CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	},
}
