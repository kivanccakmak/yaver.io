package main

import (
	"strings"
	"testing"
)

// install_node_backed_cli_test.go — the 412 → install → 412 loop.
//
// `POST /install/bunx` reported success and installed no `bunx`. The meta plan
// passed pkg="bun" as BOTH the script name and the package name, so
// installNodeBackedCLI wrote ~/.local/bin/**bun**. commandExists("bunx") then
// stayed false, detectProjectPreparation re-listed bunx as missing, the
// dev-server preflight re-issued its 412, and the phone offered the same
// Install button again — with a green install stream on every lap. A loop with
// a success indicator on each turn is worse than a failure: the user has no
// evidence anything is wrong except that nothing works.
func TestBunxShimIsNamedBunxAndRunsBunX(t *testing.T) {
	plan, ok := metaInstallPlan("bunx")
	if !ok {
		t.Fatal("bunx must have a plan — the 412 advertises POST /install/bunx")
	}
	if plan.name != "bunx" {
		t.Errorf("plan.name = %q, want bunx — the install stream is named install:<plan.name>", plan.name)
	}

	// The shim CONTENT is the part that was wrong. `bunx foo` is `bun x foo`.
	script := nodeBackedCLIScript("/home/dev/.yaver/runtimes/node", "bun", []string{"x"})
	if !strings.Contains(script, "exec npx -y bun x \"$@\"") {
		t.Errorf("bunx shim body = %q, want it to exec `npx -y bun x \"$@\"` — `npx -y bun foo` runs bun, not bunx", script)
	}
	// And the plain case must be untouched.
	plain := nodeBackedCLIScript("/home/dev/.yaver/runtimes/node", "vercel", nil)
	if !strings.Contains(plain, "exec npx -y vercel \"$@\"") {
		t.Errorf("plain shim body = %q — the no-subcommand form regressed", plain)
	}
	if !strings.Contains(plain, `PATH="/home/dev/.yaver/runtimes/node:$PATH"`) {
		t.Errorf("shim lost its PATH prefix: %q", plain)
	}
}

// The install must write the file the PREFLIGHT looks for. Every one of these
// names is emitted by detectProjectPreparation (devserver_http.go) and
// therefore appears verbatim in a 412's missingTools; installing it and
// producing a differently-named file is a guaranteed loop.
func TestPackageManagerPlansInstallTheNameTheyAdvertise(t *testing.T) {
	for _, name := range []string{"yarn", "pnpm", "bun", "bunx"} {
		plan, ok := metaInstallPlan(name)
		if !ok {
			t.Fatalf("%s has no plan, but the 412 names POST /install/%s", name, name)
		}
		if plan.name != name {
			t.Errorf("metaInstallPlan(%q).name = %q — the stream name and the installed file both key off this", name, plan.name)
		}
		if !installableViaAgent(name) {
			t.Errorf("%s does not resolve through installableViaAgent — the 412 would advertise an endpoint that 404s", name)
		}
		if got := installStreamNameForEndpoint("/install/" + name); got != "install:"+name {
			t.Errorf("stream for %s = %q, want install:%s", name, got, name)
		}
	}
}
