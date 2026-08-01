package main

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// ops_remote_repair.go — diagnose, and optionally repair, a remote box.
//
// The decision logic lives in remote_box_repair_plan.go as a pure function.
// This file is only the two impure halves: getting observations off a machine,
// and carrying out the repairs the planner marked deterministic.
//
// The probe is ONE ssh round trip emitting key=value lines. It is deliberately
// not a series of calls: a box in this state is often slow or flapping, and
// five sequential ssh sessions turn a diagnosis into a coffee break. The parser
// is pure and tested against captured real output, because that is the half
// that silently rots when a remote tool changes its wording.

// remoteBoxProbeScript prints a stable key=value block. Every value degrades to
// "unknown" rather than failing the script — a probe that dies on its third
// line tells you less than one that reports three facts and two gaps.
const remoteBoxProbeScript = `
set +e
EXE="$(systemctl show yaver -p ExecStart --value 2>/dev/null | sed -n 's/.*path=\([^ ;]*\).*/\1/p')"
if [ -z "$EXE" ]; then EXE="$HOME/.yaver/bin/current/linux-arm64/yaver"; fi
echo "binary_path=$EXE"

# Probe the OPERATION, not the inventory: a file can exist, be +x, and still be
# unrunnable (a symlink to itself is the case that took a box down).
ERR="$("$EXE" --version 2>&1 >/dev/null)"
if "$EXE" --version >/dev/null 2>&1; then
  echo "binary_exec_ok=1"
else
  echo "binary_exec_ok=0"
  echo "binary_exec_err=$(echo "$ERR" | head -1 | tr -d '\n')"
fi

if [ -f "$EXE.previous" ]; then echo "backup_present=1"; else echo "backup_present=0"; fi

if systemctl is-active --quiet yaver 2>/dev/null; then echo "service_active=1"; else echo "service_active=0"; fi

PORT="$(systemctl show yaver -p ExecStart --value 2>/dev/null | sed -n 's/.*--port=\([0-9]*\).*/\1/p')"
if [ -z "$PORT" ]; then PORT=18080; fi
CODE="$(curl -s -m 8 -o /dev/null -w '%{http_code}' "http://localhost:$PORT/health" 2>/dev/null)"
echo "health_http=${CODE:-0}"

if "$EXE" status 2>/dev/null | grep -qi 'Auth:.*valid'; then echo "session_valid=1"; else echo "session_valid=0"; fi

echo "cached_pin=$(python3 - <<'PY' 2>/dev/null
import json,os
try:
    c=json.load(open(os.path.expanduser("~/.yaver/config.json")))
    for k in ("cached_relay_servers","relay_servers"):
        for rs in c.get(k) or []:
            p=(rs.get("spki_pin") or "").strip()
            if p: print(p); raise SystemExit
except Exception: pass
PY
)"

echo "disk_used_pct=$(df -P / 2>/dev/null | awk 'NR==2{gsub(/%/,"",$5); print $5}')"
`

// parseRemoteBoxProbe turns the probe's key=value block into an observation.
//
// Unknown or missing keys keep their zero value, which the planner reads
// conservatively (an unknown pin is not a mismatch; an unknown disk is not
// pressure). Guessing here would manufacture findings out of a failed probe.
func parseRemoteBoxProbe(out, platformPin string) remoteBoxObservation {
	obs := remoteBoxObservation{PlatformSpkiPin: strings.TrimSpace(platformPin)}
	for _, line := range strings.Split(out, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		v = strings.TrimSpace(v)
		switch strings.TrimSpace(k) {
		case "binary_exec_ok":
			obs.AgentBinaryExecutable = v == "1"
		case "binary_exec_err":
			obs.AgentBinaryError = v
		case "backup_present":
			obs.BackupBinaryPresent = v == "1"
		case "service_active":
			obs.ServiceActive = v == "1"
		case "health_http":
			obs.HealthHTTP, _ = strconv.Atoi(v)
		case "session_valid":
			obs.SessionValid = v == "1"
		case "cached_pin":
			obs.CachedSpkiPin = v
		case "disk_used_pct":
			obs.DiskUsedPct, _ = strconv.Atoi(v)
		}
	}
	return obs
}

// remoteRepairCommand returns the shell to run for an auto-fixable finding, or
// "" when the finding is not one we may act on. Keeping this a lookup rather
// than a branch inside the executor means "what may we do unattended" is
// answerable by reading one function.
func remoteRepairCommand(f remoteBoxFinding, binaryPath, freshPin string) string {
	switch f.Check {
	case "agent_binary":
		// Restore via rename, never cp-over-the-target: the running binary may
		// be the file being replaced, and a half-written one is a second
		// outage. Same reasoning as the atomic symlink swap in process_unix.go.
		return fmt.Sprintf(`cp -a %q %q && mv -f %q %q && chmod 755 %q && systemctl restart yaver`,
			binaryPath+".previous", binaryPath+".restore.tmp",
			binaryPath+".restore.tmp", binaryPath, binaryPath)
	case "agent_service":
		return "systemctl restart yaver"
	case "relay_pin":
		if strings.TrimSpace(freshPin) == "" {
			return ""
		}
		return fmt.Sprintf(`python3 - <<'PY'
import json,os
p=os.path.expanduser("~/.yaver/config.json")
c=json.load(open(p))
NEW=%q
n=0
for k in ("cached_relay_servers","relay_servers"):
    for rs in c.get(k) or []:
        for f in ("spki_pin","spkiPin"):
            if f in rs and rs[f]!=NEW:
                rs[f]=NEW; n+=1
json.dump(c,open(p,"w"),indent=2)
print("pins_updated=%%d"%%n)
PY`, freshPin)
	}
	return ""
}

type opsRemoteRepairPayload struct {
	Target string `json:"target"`
	Apply  bool   `json:"apply,omitempty"`
}

func init() {
	registerOpsVerb(opsVerbSpec{
		Name: "remote_repair",
		Description: "Diagnose a remote box over SSH and, with apply=true, perform only the deterministic repairs " +
			"(restore a destroyed agent binary from its own backup, restart an agent that is 'active' but answering " +
			"nothing, refresh a stale relay SPKI pin). Signing a box in and reclaiming disk are reported, never automated.",
		Schema: map[string]interface{}{
			"type":     "object",
			"required": []string{"target"},
			"properties": map[string]interface{}{
				"target": map[string]interface{}{"type": "string", "description": "ssh target name (see `yaver ssh`), or user@host"},
				"apply":  map[string]interface{}{"type": "boolean", "default": false, "description": "perform the auto-fixable repairs; default is diagnose-only"},
			},
			"additionalProperties": false,
		},
		Handler:    opsRemoteRepairHandler,
		AllowGuest: false,
	})
}

func opsRemoteRepairHandler(_ OpsContext, payload json.RawMessage) OpsResult {
	var p opsRemoteRepairPayload
	if err := json.Unmarshal(payload, &p); err != nil {
		return OpsResult{OK: false, Code: "bad_payload", Error: err.Error()}
	}
	host, user := resolveRemoteRepairTarget(strings.TrimSpace(p.Target))
	if host == "" {
		return OpsResult{OK: false, Code: "bad_payload",
			Error: "target must be a configured ssh target name or user@host — `yaver ssh` lists what this machine knows"}
	}

	out, err := sshRun(host, user, remoteBoxProbeScript)
	if err != nil && strings.TrimSpace(out) == "" {
		return OpsResult{OK: false, Code: "not_found",
			Error: fmt.Sprintf("could not reach %s@%s over ssh: %v", user, host, err)}
	}

	// The authoritative pin comes from the control plane, not the box — that is
	// the whole reason a rotated relay identity is recoverable at all.
	platformPin := ""
	if cfg, cerr := LoadConfig(); cerr == nil && cfg != nil && strings.TrimSpace(cfg.ConvexSiteURL) != "" {
		if servers, ferr := FetchRelayServers(strings.TrimRight(cfg.ConvexSiteURL, "/")); ferr == nil {
			for _, rs := range servers {
				if strings.TrimSpace(rs.SpkiPin) != "" {
					platformPin = strings.TrimSpace(rs.SpkiPin)
					break
				}
			}
		}
	}

	obs := parseRemoteBoxProbe(out, platformPin)
	findings := planRemoteBoxRepair(obs)

	result := map[string]interface{}{
		"target":   fmt.Sprintf("%s@%s", user, host),
		"findings": findings,
		"healthy":  remoteBoxRepairIsClean(findings),
		"applied":  []interface{}{},
	}
	if !p.Apply || len(findings) == 0 {
		return OpsResult{OK: true, Initial: result}
	}

	binaryPath := remoteBinaryPathFromProbe(out)
	var applied []map[string]interface{}
	for _, f := range findings {
		if !f.AutoFixable {
			continue
		}
		cmd := remoteRepairCommand(f, binaryPath, platformPin)
		if cmd == "" {
			continue
		}
		cmdOut, cmdErr := sshRun(host, user, cmd)
		entry := map[string]interface{}{"check": f.Check, "output": strings.TrimSpace(cmdOut)}
		if cmdErr != nil {
			entry["error"] = cmdErr.Error()
		}
		applied = append(applied, entry)
	}
	result["applied"] = applied
	return OpsResult{OK: true, Initial: result}
}

// remoteBinaryPathFromProbe pulls the ExecStart path the probe resolved, so a
// repair acts on the binary the supervisor actually launches rather than a
// guess at the install layout.
func remoteBinaryPathFromProbe(out string) string {
	for _, line := range strings.Split(out, "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(line), "binary_path="); ok {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// resolveRemoteRepairTarget accepts a configured ssh-target name or a bare
// user@host / host.
func resolveRemoteRepairTarget(target string) (host, user string) {
	if target == "" {
		return "", ""
	}
	if cfg, err := LoadConfig(); err == nil && cfg != nil {
		if t := lookupSSHTarget(cfg, target); t != nil && strings.TrimSpace(t.Host) != "" {
			u := strings.TrimSpace(t.User)
			if u == "" {
				u = "root"
			}
			return strings.TrimSpace(t.Host), u
		}
	}
	if u, h, ok := strings.Cut(target, "@"); ok && h != "" {
		return strings.TrimSpace(h), strings.TrimSpace(u)
	}
	return target, "root"
}
