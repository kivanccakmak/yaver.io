package main

// ops_dns.go — verb "dns": unified DNS record management across
// whichever DNS provider the user has wired (Cloudflare today;
// Route 53 / Porkbun / Namecheap pending). Thin op-discriminator
// over the existing dns_* domain tools.

import "encoding/json"

type opsDNSPayload struct {
	Op     string `json:"op"`                // list | add | remove | lookup | flush | localname-status | localname-set | localname-restore
	Domain string `json:"domain,omitempty"`  // zone for list/add/remove
	Name   string `json:"name,omitempty"`    // record name (a.k.a. subdomain) or the desired .local name for localname-set
	Type   string `json:"type,omitempty"`    // A|AAAA|CNAME|TXT|MX|...
	Value  string `json:"value,omitempty"`   // record value
	TTL    int    `json:"ttl,omitempty"`
	Host   string `json:"host,omitempty"`    // for lookup
}

func init() {
	registerOpsVerb(opsVerbSpec{
		Name:        "dns",
		Description: "Manage DNS records via the wired provider, or this machine's mDNS .local LAN name. ops: list/add/remove/lookup/flush (provider records) or localname-status/localname-set/localname-restore (this box's *.local name for LAN reachability).",
		Schema: map[string]interface{}{
			"type":     "object",
			"required": []string{"op"},
			"properties": map[string]interface{}{
				"op":     map[string]interface{}{"type": "string", "enum": []string{"list", "add", "remove", "lookup", "flush", "localname-status", "localname-set", "localname-restore"}},
				"domain": map[string]interface{}{"type": "string"},
				"name":   map[string]interface{}{"type": "string"},
				"type":   map[string]interface{}{"type": "string"},
				"value":  map[string]interface{}{"type": "string"},
				"ttl":    map[string]interface{}{"type": "integer"},
				"host":   map[string]interface{}{"type": "string"},
			},
			"additionalProperties": false,
		},
		Handler:    opsDNSHandler,
		Streaming:  false,
		AllowGuest: false,
	})
}

func opsDNSHandler(_ OpsContext, payload json.RawMessage) OpsResult {
	var p opsDNSPayload
	if err := json.Unmarshal(payload, &p); err != nil {
		return OpsResult{OK: false, Code: "bad_payload", Error: err.Error()}
	}
	var tool string
	switch p.Op {
	case "list":
		tool = "dns_list"
	case "add":
		tool = "dns_add"
	case "remove":
		tool = "dns_remove"
	case "lookup":
		tool = "dns_lookup"
	case "flush":
		tool = "dns_flush"
	case "localname-status":
		tool = "dns_localname_status"
	case "localname-set":
		tool = "dns_localname_set"
	case "localname-restore":
		tool = "dns_localname_restore"
	default:
		return OpsResult{OK: false, Code: "bad_payload", Error: "unknown op: " + p.Op}
	}
	return OpsResult{OK: true, Initial: map[string]interface{}{
		"hint":    "call the " + tool + " MCP tool — handles provider resolution + credentials",
		"mcpTool": tool,
		"args":    p,
	}}
}
