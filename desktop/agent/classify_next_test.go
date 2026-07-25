package main

// The /projects classifier and NextDevServer.Detect must give the SAME answer.
//
// They didn't: the classifier keyed on next.config.* only, so yaver-todo-web (a
// create-next-app project, which ships no next.config) was labelled "react". The
// UI sends that label straight back to /dev/start, and "react" has no dev server —
// browser lane 404, WebRTC lane "react projects use webview". Fixing only the
// dev-server registry would have left the UI still asking for the wrong thing.

import "testing"

func TestClassifierAndDevServerAgreeOnNext(t *testing.T) {
	dir := writeDetectFixture(t, map[string]string{
		"package.json": `{"name":"todo-web","scripts":{"dev":"next dev"},
			"dependencies":{"next":"^15.0.0","react":"^19.0.0"}}`,
		"app/page.tsx": "export default function P(){return null}",
	})

	if got := detectFramework(dir); got != "nextjs" {
		t.Errorf("classifier says %q for a config-less Next app; the UI would send that to /dev/start, "+
			"which cannot start it", got)
	}
	if !(&NextDevServer{}).Detect(dir) {
		t.Error("NextDevServer.Detect disagrees with the classifier — one project, two answers")
	}
}

func TestClassifierStillSaysReactForPlainReact(t *testing.T) {
	dir := writeDetectFixture(t, map[string]string{
		"package.json": `{"dependencies":{"react":"^19","react-dom":"^19"}}`,
	})
	if got := detectFramework(dir); got == "nextjs" {
		t.Error("a plain React app was upgraded to nextjs — a wrong dev server is worse than none")
	}
}
