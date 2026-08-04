package main

// false_green_test.go — never report success for an operation that did not
// happen.
//
// HANDOFF #14 asked for an audit of the 816 `ok:true` replies in this agent,
// calling it "the highest-risk pass in the repo: a false green is invisible by
// construction". It is invisible because nothing fails — the caller is TOLD it
// worked, so no log, no status page and no test notices. The only way it
// surfaces is a human eventually asking "why did nothing change?".
//
// CLAUDE.md names the shape exactly: `if x != nil` with no `else`, then
// `{"ok":true}`. Two instances were named there; this file pins the first one
// found by measuring rather than by reading — feedback_fix — and then guards the
// class so the next one cannot be added silently.
//
// WHY A RATCHET AND NOT A SWEEP. 816 replies cannot be hand-verified once and
// declared safe; the number grows every week. What CAN be held is the specific
// dependency-nil-then-succeed pattern, which is what actually produced both
// documented instances.

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestFeedbackFixRefusesWithoutATaskManager — the measured instance.
//
// With no task manager the handler used to answer 200 {"ok":true, prompt, no
// taskId}: every surface rendered a success alert while nothing had been
// dispatched, and the user waited for a coding agent that was never asked.
func TestFeedbackFixRefusesWithoutATaskManager(t *testing.T) {
	// HOME is isolated FIRST: NewFeedbackManager resolves ConfigDir(), which
	// reads the real ~/.yaver. A test in this package has already signed a
	// developer out of Yaver by touching that (1.99.309); never again.
	t.Setenv("HOME", t.TempDir())

	// taskMgr nil is the whole point of the fixture.
	hs := NewHTTPServer(0, "test-token", "test-user", "test-device", "", "test-host", nil)
	fm, err := NewFeedbackManager()
	if err != nil {
		t.Skipf("feedback manager unavailable in this environment: %v", err)
	}
	hs.feedbackMgr = fm

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/feedback/does-not-matter/fix", strings.NewReader("{}"))
	req.Header.Set("Content-Type", "application/json")
	hs.handleFeedbackFix(rec, req, "does-not-matter")

	// Whatever else it does, it must NOT claim success.
	var body map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)

	if rec.Code == http.StatusOK && body["ok"] == true {
		t.Fatalf("handler answered 200 ok:true with no task manager — a success alert over a no-op. body=%v", body)
	}
	// When it is the missing task manager (rather than a bad id or bad JSON),
	// it must say so with the stable code, not just a status.
	if rec.Code == http.StatusServiceUnavailable {
		if body["code"] != ReasonTaskManagerUnavailable {
			t.Errorf("code = %v, want %q so surfaces classify instead of regexing the sentence", body["code"], ReasonTaskManagerUnavailable)
		}
		if body["ok"] == true {
			t.Error("ok must be false on a refusal")
		}
	}
}

// TestNoDependencyNilThenSucceed is the class guard, built on the AST.
//
// The first version was a line regex: "if s.X != nil {" followed by an ok:true
// within six lines. It flagged EIGHT files and MISSED remote_runtime.go — the
// instance CLAUDE.md names — i.e. it was wrong in both directions at once. A
// detector with that profile cannot justify an allowlist; listing eight files as
// "known" would have been fiction dressed as an audit, which is exactly the
// failure this session already corrected twice.
//
// go/ast makes the real question answerable: within ONE function, does an
// `if <dep> != nil { … }` block that contains the work get followed by a success
// reply that is NOT inside the block? That is the shape, and nothing else is.
func TestNoDependencyNilThenSucceed(t *testing.T) {
	// Sites still carrying the pattern, each with why it has not been changed.
	// Deleting a line is how a fix is recorded.
	known := map[string]string{}

	root := repoRoot(t)
	dir := filepath.Join(root, "desktop", "agent")
	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, dir, func(fi os.FileInfo) bool {
		return strings.HasSuffix(fi.Name(), ".go") && !strings.HasSuffix(fi.Name(), "_test.go")
	}, 0)
	if err != nil {
		t.Fatalf("parse agent package: %v", err)
	}

	// repliesSuccess reports whether a statement is a success reply.
	repliesSuccess := func(n ast.Node) bool {
		found := false
		ast.Inspect(n, func(x ast.Node) bool {
			kv, ok := x.(*ast.KeyValueExpr)
			if !ok {
				return true
			}
			k, ok := kv.Key.(*ast.BasicLit)
			if !ok || k.Kind != token.STRING || k.Value != `"ok"` {
				return true
			}
			if id, ok := kv.Value.(*ast.Ident); ok && id.Name == "true" {
				found = true
			}
			return true
		})
		return found
	}

	type hit struct {
		file string
		line int
		fn   string
	}
	var hits []hit

	for _, pkg := range pkgs {
		for path, file := range pkg.Files {
			ast.Inspect(file, func(n ast.Node) bool {
				fn, ok := n.(*ast.FuncDecl)
				if !ok || fn.Body == nil {
					return true
				}
				for i, stmt := range fn.Body.List {
					ifs, ok := stmt.(*ast.IfStmt)
					// The guard: `if <sel> != nil {` with no else.
					if !ok || ifs.Else != nil {
						continue
					}
					bin, ok := ifs.Cond.(*ast.BinaryExpr)
					if !ok || bin.Op != token.NEQ {
						continue
					}
					if id, ok := bin.Y.(*ast.Ident); !ok || id.Name != "nil" {
						continue
					}
					if _, ok := bin.X.(*ast.SelectorExpr); !ok {
						continue
					}
					// The block must CONTAIN a success reply (i.e. it is the
					// happy path doing the work)…
					if !repliesSuccess(ifs.Body) {
						continue
					}
					// …and a LATER statement in the same function must reply
					// success too — that is the branch reached when the
					// dependency is nil and nothing was done.
					for _, later := range fn.Body.List[i+1:] {
						if repliesSuccess(later) {
							hits = append(hits, hit{
								file: filepath.Base(path),
								line: fset.Position(later.Pos()).Line,
								fn:   fn.Name.Name,
							})
							break
						}
					}
				}
				return true
			})
		}
	}

	seen := map[string]bool{}
	for _, h := range hits {
		seen[h.file] = true
		if _, listed := known[h.file]; !listed {
			t.Errorf("%s:%d (%s): a dependency-nil guard does the work and replies ok:true, and a LATER reply also says ok:true — that later one is reached when the dependency is missing, so the caller is told an operation succeeded that never ran. Refuse with a named code (see feedback_http.go's ReasonTaskManagerUnavailable), or add the file to `known` with the reason.",
				h.file, h.line, h.fn)
		}
	}
	for name, why := range known {
		if !seen[name] {
			t.Errorf("%s no longer matches the false-green shape — delete it from `known` (%s).", name, why)
		}
	}
	t.Logf("dependency-nil-then-succeed sites: %d", len(hits))
}
