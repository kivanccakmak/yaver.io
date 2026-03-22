package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"math/big"
	"math/rand"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// Crypto prices — CoinGecko (FREE, no key)
// ---------------------------------------------------------------------------

func mcpCryptoPrice(coins []string) interface{} {
	if len(coins) == 0 {
		coins = []string{"bitcoin", "ethereum"}
	}
	ids := strings.Join(coins, ",")
	u := fmt.Sprintf("https://api.coingecko.com/api/v3/simple/price?ids=%s&vs_currencies=usd,eur&include_24hr_change=true", ids)
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(u)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var result interface{}
	json.Unmarshal(body, &result)
	return result
}

// ---------------------------------------------------------------------------
// Currency exchange — frankfurter.app (FREE, no key, ECB rates)
// ---------------------------------------------------------------------------

func mcpCurrencyExchange(amount float64, from, to string) interface{} {
	if from == "" {
		from = "USD"
	}
	if to == "" {
		to = "EUR"
	}
	u := fmt.Sprintf("https://api.frankfurter.app/latest?amount=%f&from=%s&to=%s",
		amount, strings.ToUpper(from), strings.ToUpper(to))
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(u)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var result interface{}
	json.Unmarshal(body, &result)
	return result
}

// ---------------------------------------------------------------------------
// NPM package info — registry.npmjs.org (FREE)
// ---------------------------------------------------------------------------

func mcpNPMInfo(pkg string) interface{} {
	u := "https://registry.npmjs.org/" + url.PathEscape(pkg)
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(u)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var data map[string]interface{}
	json.Unmarshal(body, &data)

	latest := ""
	if distTags, ok := data["dist-tags"].(map[string]interface{}); ok {
		latest, _ = distTags["latest"].(string)
	}
	desc, _ := data["description"].(string)
	license, _ := data["license"].(string)
	homepage, _ := data["homepage"].(string)

	// Weekly downloads
	dlURL := fmt.Sprintf("https://api.npmjs.org/downloads/point/last-week/%s", pkg)
	dlResp, err := client.Get(dlURL)
	var weeklyDL interface{}
	if err == nil {
		defer dlResp.Body.Close()
		dlBody, _ := io.ReadAll(dlResp.Body)
		var dlData map[string]interface{}
		json.Unmarshal(dlBody, &dlData)
		weeklyDL = dlData["downloads"]
	}

	return map[string]interface{}{
		"name":             pkg,
		"version":          latest,
		"description":      desc,
		"license":          license,
		"homepage":         homepage,
		"weekly_downloads": weeklyDL,
	}
}

// ---------------------------------------------------------------------------
// GitHub trending — scrape (FREE)
// ---------------------------------------------------------------------------

func mcpGitHubTrending(language, since string) interface{} {
	if since == "" {
		since = "daily"
	}
	u := "https://api.github.com/search/repositories?q=stars:>100+pushed:>" + time.Now().AddDate(0, 0, -7).Format("2006-01-02")
	if language != "" {
		u += "+language:" + url.QueryEscape(language)
	}
	u += "&sort=stars&order=desc&per_page=15"

	client := &http.Client{Timeout: 10 * time.Second}
	req, _ := http.NewRequest("GET", u, nil)
	req.Header.Set("Accept", "application/vnd.github.v3+json")
	resp, err := client.Do(req)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	var data map[string]interface{}
	json.Unmarshal(body, &data)

	var repos []map[string]interface{}
	if items, ok := data["items"].([]interface{}); ok {
		for _, item := range items {
			if m, ok := item.(map[string]interface{}); ok {
				repos = append(repos, map[string]interface{}{
					"name":        m["full_name"],
					"description": m["description"],
					"stars":       m["stargazers_count"],
					"language":    m["language"],
					"url":         m["html_url"],
				})
			}
		}
	}
	return map[string]interface{}{"trending": repos, "count": len(repos)}
}

// ---------------------------------------------------------------------------
// JWT decode — local, no API
// ---------------------------------------------------------------------------

func mcpJWTDecode(token string) interface{} {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return map[string]interface{}{"error": "invalid JWT: expected 3 parts separated by dots"}
	}

	decodeSegment := func(seg string) (map[string]interface{}, error) {
		// Add padding
		switch len(seg) % 4 {
		case 2:
			seg += "=="
		case 3:
			seg += "="
		}
		decoded, err := base64.URLEncoding.DecodeString(seg)
		if err != nil {
			return nil, err
		}
		var result map[string]interface{}
		json.Unmarshal(decoded, &result)
		return result, nil
	}

	header, err := decodeSegment(parts[0])
	if err != nil {
		return map[string]interface{}{"error": "cannot decode header: " + err.Error()}
	}
	payload, err := decodeSegment(parts[1])
	if err != nil {
		return map[string]interface{}{"error": "cannot decode payload: " + err.Error()}
	}

	// Check expiry
	result := map[string]interface{}{
		"header":  header,
		"payload": payload,
	}
	if exp, ok := payload["exp"].(float64); ok {
		expTime := time.Unix(int64(exp), 0)
		result["expires"] = expTime.Format(time.RFC3339)
		result["expired"] = time.Now().After(expTime)
	}
	if iat, ok := payload["iat"].(float64); ok {
		result["issued_at"] = time.Unix(int64(iat), 0).Format(time.RFC3339)
	}
	return result
}

// ---------------------------------------------------------------------------
// Epoch / timestamp converter
// ---------------------------------------------------------------------------

func mcpEpoch(input string) interface{} {
	if input == "" || input == "now" {
		now := time.Now()
		return map[string]interface{}{
			"unix":      now.Unix(),
			"unix_ms":   now.UnixMilli(),
			"iso8601":   now.Format(time.RFC3339),
			"human":     now.Format("2006-01-02 15:04:05 MST"),
			"utc":       now.UTC().Format("2006-01-02 15:04:05 UTC"),
		}
	}

	// Try parsing as unix timestamp
	if ts, err := strconv.ParseInt(input, 10, 64); err == nil {
		var t time.Time
		if ts > 1e12 {
			t = time.UnixMilli(ts)
		} else {
			t = time.Unix(ts, 0)
		}
		return map[string]interface{}{
			"unix":    t.Unix(),
			"unix_ms": t.UnixMilli(),
			"iso8601": t.Format(time.RFC3339),
			"human":   t.Format("2006-01-02 15:04:05 MST"),
			"utc":     t.UTC().Format("2006-01-02 15:04:05 UTC"),
		}
	}

	// Try parsing as date string
	formats := []string{time.RFC3339, "2006-01-02", "2006-01-02 15:04:05", "Jan 2, 2006", "01/02/2006"}
	for _, f := range formats {
		if t, err := time.Parse(f, input); err == nil {
			return map[string]interface{}{
				"unix":    t.Unix(),
				"unix_ms": t.UnixMilli(),
				"iso8601": t.Format(time.RFC3339),
				"human":   t.Format("2006-01-02 15:04:05 MST"),
			}
		}
	}
	return map[string]interface{}{"error": "cannot parse: " + input}
}

// ---------------------------------------------------------------------------
// Cron expression explainer
// ---------------------------------------------------------------------------

func mcpCronExplain(expression string) interface{} {
	parts := strings.Fields(expression)
	if len(parts) != 5 {
		return map[string]interface{}{"error": "expected 5 fields: minute hour day month weekday"}
	}

	fieldNames := []string{"minute", "hour", "day of month", "month", "day of week"}
	explanations := make(map[string]string)
	for i, part := range parts {
		explanations[fieldNames[i]] = explainCronField(part, fieldNames[i])
	}

	return map[string]interface{}{
		"expression":   expression,
		"fields":       explanations,
		"description":  buildCronDescription(parts),
	}
}

func explainCronField(field, name string) string {
	if field == "*" {
		return "every " + name
	}
	if strings.Contains(field, "/") {
		parts := strings.SplitN(field, "/", 2)
		return fmt.Sprintf("every %s %s", parts[1], name)
	}
	if strings.Contains(field, ",") {
		return name + " " + field
	}
	if strings.Contains(field, "-") {
		return name + " " + field
	}
	return name + " " + field
}

func buildCronDescription(parts []string) string {
	min, hour := parts[0], parts[1]
	dom, mon, dow := parts[2], parts[3], parts[4]

	desc := "Runs "
	if min == "0" && hour == "*" {
		desc += "every hour"
	} else if min == "*" {
		desc += "every minute"
	} else if hour != "*" && min != "*" {
		desc += fmt.Sprintf("at %s:%s", hour, fmt.Sprintf("%02s", min))
	} else {
		desc += fmt.Sprintf("at minute %s", min)
	}

	if dom != "*" {
		desc += fmt.Sprintf(" on day %s", dom)
	}
	if mon != "*" {
		desc += fmt.Sprintf(" in month %s", mon)
	}
	if dow != "*" {
		days := map[string]string{"0": "Sunday", "1": "Monday", "2": "Tuesday", "3": "Wednesday", "4": "Thursday", "5": "Friday", "6": "Saturday", "7": "Sunday"}
		if d, ok := days[dow]; ok {
			desc += " on " + d
		} else {
			desc += " on weekday " + dow
		}
	}
	return desc
}

// ---------------------------------------------------------------------------
// HTTP status code lookup
// ---------------------------------------------------------------------------

func mcpHTTPStatusLookup(code int) interface{} {
	codes := map[int]string{
		100: "Continue", 101: "Switching Protocols",
		200: "OK", 201: "Created", 202: "Accepted", 204: "No Content",
		301: "Moved Permanently", 302: "Found", 304: "Not Modified", 307: "Temporary Redirect", 308: "Permanent Redirect",
		400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
		408: "Request Timeout", 409: "Conflict", 410: "Gone", 413: "Payload Too Large", 415: "Unsupported Media Type",
		418: "I'm a Teapot", 422: "Unprocessable Entity", 429: "Too Many Requests",
		500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
	}
	text, ok := codes[code]
	if !ok {
		return map[string]interface{}{"code": code, "error": "unknown status code"}
	}
	category := ""
	switch {
	case code < 200:
		category = "Informational"
	case code < 300:
		category = "Success"
	case code < 400:
		category = "Redirection"
	case code < 500:
		category = "Client Error"
	default:
		category = "Server Error"
	}
	return map[string]interface{}{"code": code, "text": text, "category": category}
}

// ---------------------------------------------------------------------------
// Whois — domain info
// ---------------------------------------------------------------------------

func mcpWhois(domain string) interface{} {
	out, err := runCmd("whois", domain)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	// Extract key fields
	lines := strings.Split(out, "\n")
	info := map[string]string{}
	for _, line := range lines {
		lower := strings.ToLower(line)
		if strings.Contains(lower, "registrar:") || strings.Contains(lower, "creation date:") ||
			strings.Contains(lower, "expir") || strings.Contains(lower, "name server:") ||
			strings.Contains(lower, "updated date:") || strings.Contains(lower, "status:") {
			parts := strings.SplitN(line, ":", 2)
			if len(parts) == 2 {
				info[strings.TrimSpace(parts[0])] = strings.TrimSpace(parts[1])
			}
		}
	}
	return map[string]interface{}{"domain": domain, "info": info, "raw_lines": len(lines)}
}

// ---------------------------------------------------------------------------
// IP geolocation — ip-api.com (FREE, no key, 45 req/min)
// ---------------------------------------------------------------------------

func mcpIPGeo(ip string) interface{} {
	if ip == "" {
		ip = "" // Will return requester's IP
	}
	u := fmt.Sprintf("http://ip-api.com/json/%s?fields=status,message,country,regionName,city,zip,lat,lon,timezone,isp,org,as,query", ip)
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(u)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var result interface{}
	json.Unmarshal(body, &result)
	return result
}

// ---------------------------------------------------------------------------
// Subnet calculator
// ---------------------------------------------------------------------------

func mcpSubnet(cidr string) interface{} {
	_, network, err := net.ParseCIDR(cidr)
	if err != nil {
		return map[string]interface{}{"error": "invalid CIDR: " + err.Error()}
	}
	ones, bits := network.Mask.Size()
	hostBits := bits - ones
	totalHosts := math.Pow(2, float64(hostBits))
	usableHosts := totalHosts - 2
	if usableHosts < 0 {
		usableHosts = 0
	}

	// Calculate broadcast
	ip := network.IP.To4()
	if ip == nil {
		ip = network.IP.To16()
	}
	broadcast := make(net.IP, len(ip))
	for i := range ip {
		broadcast[i] = ip[i] | ^network.Mask[i]
	}

	// First and last usable
	firstUsable := make(net.IP, len(ip))
	copy(firstUsable, ip)
	firstUsable[len(firstUsable)-1]++
	lastUsable := make(net.IP, len(broadcast))
	copy(lastUsable, broadcast)
	lastUsable[len(lastUsable)-1]--

	return map[string]interface{}{
		"cidr":         cidr,
		"network":      network.IP.String(),
		"netmask":      net.IP(network.Mask).String(),
		"broadcast":    broadcast.String(),
		"first_usable": firstUsable.String(),
		"last_usable":  lastUsable.String(),
		"total_hosts":  int(totalHosts),
		"usable_hosts": int(usableHosts),
		"prefix_length": ones,
	}
}

// ---------------------------------------------------------------------------
// Fake data generator — for testing
// ---------------------------------------------------------------------------

func mcpFakeData(dataType string, count int) interface{} {
	if count <= 0 {
		count = 1
	}
	if count > 20 {
		count = 20
	}

	firstNames := []string{"James", "Emma", "Liam", "Olivia", "Noah", "Ava", "Sophia", "Mason", "Isabella", "Lucas", "Mia", "Ethan", "Charlotte", "Aiden", "Amelia"}
	lastNames := []string{"Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez", "Wilson", "Anderson", "Taylor", "Thomas", "Moore"}
	domains := []string{"gmail.com", "outlook.com", "yahoo.com", "example.com", "test.com"}
	streets := []string{"Main St", "Oak Ave", "Park Rd", "Cedar Ln", "Elm St", "Pine Dr", "Maple Ave", "Washington Blvd"}
	cities := []string{"New York", "Los Angeles", "Chicago", "Houston", "Phoenix", "San Francisco", "Seattle", "Austin", "Denver", "Boston"}

	var results []map[string]interface{}
	for i := 0; i < count; i++ {
		first := firstNames[rand.Intn(len(firstNames))]
		last := lastNames[rand.Intn(len(lastNames))]
		email := strings.ToLower(first) + "." + strings.ToLower(last) + "@" + domains[rand.Intn(len(domains))]

		switch dataType {
		case "user", "person", "":
			results = append(results, map[string]interface{}{
				"name":    first + " " + last,
				"email":   email,
				"phone":   fmt.Sprintf("+1-%03d-%03d-%04d", rand.Intn(900)+100, rand.Intn(900)+100, rand.Intn(9000)+1000),
				"address": fmt.Sprintf("%d %s, %s", rand.Intn(9000)+100, streets[rand.Intn(len(streets))], cities[rand.Intn(len(cities))]),
				"age":     rand.Intn(50) + 18,
			})
		case "email":
			results = append(results, map[string]interface{}{"email": email})
		case "address":
			results = append(results, map[string]interface{}{
				"street":  fmt.Sprintf("%d %s", rand.Intn(9000)+100, streets[rand.Intn(len(streets))]),
				"city":    cities[rand.Intn(len(cities))],
				"zip":     fmt.Sprintf("%05d", rand.Intn(90000)+10000),
				"country": "US",
			})
		case "uuid":
			n1, _ := randBig(math.MaxInt64)
			results = append(results, map[string]interface{}{"uuid": fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", n1.Int64()&0xFFFFFFFF, n1.Int64()&0xFFFF, n1.Int64()&0xFFFF, n1.Int64()&0xFFFF, n1.Int64()&0xFFFFFFFFFFFF)})
		case "credit_card":
			results = append(results, map[string]interface{}{
				"number":  fmt.Sprintf("4%015d", rand.Int63n(1e15)),
				"expiry":  fmt.Sprintf("%02d/%d", rand.Intn(12)+1, time.Now().Year()+rand.Intn(5)+1),
				"cvv":     fmt.Sprintf("%03d", rand.Intn(900)+100),
				"note":    "FAKE — for testing only",
			})
		default:
			return map[string]interface{}{"error": "type must be: user, email, address, uuid, credit_card"}
		}
	}
	if count == 1 {
		return results[0]
	}
	return map[string]interface{}{"data": results, "count": count}
}

func randBig(max int64) (*big.Int, error) {
	return big.NewInt(rand.Int63n(max)), nil
}

// ---------------------------------------------------------------------------
// Domain availability check — simple DNS lookup
// ---------------------------------------------------------------------------

func mcpDomainCheck(domain string) interface{} {
	_, err := net.LookupHost(domain)
	registered := err == nil
	whoisInfo := map[string]interface{}{}
	if registered {
		out, _ := runCmd("whois", domain)
		if out != "" {
			for _, line := range strings.Split(out, "\n") {
				lower := strings.ToLower(line)
				if strings.Contains(lower, "creation date:") || strings.Contains(lower, "expir") || strings.Contains(lower, "registrar:") {
					parts := strings.SplitN(line, ":", 2)
					if len(parts) == 2 {
						whoisInfo[strings.TrimSpace(parts[0])] = strings.TrimSpace(parts[1])
					}
				}
			}
		}
	}
	return map[string]interface{}{
		"domain":     domain,
		"registered": registered,
		"available":  !registered,
		"whois":      whoisInfo,
	}
}
