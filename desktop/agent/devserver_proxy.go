package main

import (
	"net/http"
	"net/http/httputil"
	"net/url"
)

// newDevServerReverseProxy is the browser-facing /dev/ hop. The framework
// server itself is plain HTTP on loopback, while the user-facing Yaver path is
// a secure app/relay session. Mark that original transport as secure so common
// HTTPS-enforcement middleware does not redirect the capture browser to TLS on
// the framework's plain-HTTP port. Without this, Yaver web answered 308 to
// https://0.0.0.0:3000 and every TV/mobile/headset capture failed after the
// server had already become ready.
func newDevServerReverseProxy(target *url.URL) *httputil.ReverseProxy {
	proxy := httputil.NewSingleHostReverseProxy(target)
	direct := proxy.Director
	proxy.Director = func(request *http.Request) {
		direct(request)
		request.Header.Set("X-Forwarded-Proto", "https")
	}
	return proxy
}
