package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// All tools below use free/open APIs (OpenStreetMap, OpenChargeMap, etc.).
// Users can run these locally via `yaver mcp` or on their own VPS.
// Alternatively, they can use the Yaver hosted MCP service which runs
// these tools on our infrastructure (managed relay subscription).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// EV Charging — OpenChargeMap (FREE API, no key needed)
// ---------------------------------------------------------------------------

func mcpEVCharging(lat, lon float64, radius int, connectorType, network, country string, minPowerKW int) interface{} {
	if radius <= 0 {
		radius = 10
	}
	u := fmt.Sprintf("https://api.openchargemap.io/v3/poi/?output=json&latitude=%f&longitude=%f&distance=%d&distanceunit=KM&maxresults=20&compact=true&verbose=false",
		lat, lon, radius)
	if connectorType != "" {
		u += "&connectiontypeid=" + connectorType
	}
	if country != "" {
		// Country code mapping
		countryCodes := map[string]string{
			"turkey": "TR", "tr": "TR", "us": "US", "usa": "US", "uk": "GB", "gb": "GB",
			"germany": "DE", "de": "DE", "france": "FR", "fr": "FR", "nl": "NL",
			"netherlands": "NL", "spain": "ES", "es": "ES", "italy": "IT", "it": "IT",
			"norway": "NO", "no": "NO", "sweden": "SE", "se": "SE",
		}
		if code, ok := countryCodes[strings.ToLower(country)]; ok {
			u += "&countrycode=" + code
		} else {
			u += "&countrycode=" + strings.ToUpper(country)
		}
	}
	if minPowerKW > 0 {
		u += fmt.Sprintf("&minpowerkw=%d", minPowerKW)
	}
	// Network/operator filtering via OpenChargeMap operator IDs
	networkIDs := map[string]string{
		"tesla":        "23",
		"supercharger": "23",
		"ionity":       "3534",
		"chargepoint":  "5",
		"evgo":         "26",
		"electrify":    "3534",
		"shell":        "3299",
		"bp":           "3392",
		"gridserve":    "3420",
	}
	if network != "" {
		if id, ok := networkIDs[strings.ToLower(network)]; ok {
			u += "&operatorid=" + id
		}
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(u)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	var stations []interface{}
	json.Unmarshal(body, &stations)

	var results []map[string]interface{}
	for _, s := range stations {
		if m, ok := s.(map[string]interface{}); ok {
			info := map[string]interface{}{}
			if ai, ok := m["AddressInfo"].(map[string]interface{}); ok {
				info["title"] = ai["Title"]
				info["address"] = ai["AddressLine1"]
				info["town"] = ai["Town"]
				info["country"] = ai["Country"]
				info["distance_km"] = ai["Distance"]
				info["latitude"] = ai["Latitude"]
				info["longitude"] = ai["Longitude"]
			}
			if op, ok := m["OperatorInfo"].(map[string]interface{}); ok && op != nil {
				info["operator"] = op["Title"]
				info["operator_website"] = op["WebsiteURL"]
			}
			if conns, ok := m["Connections"].([]interface{}); ok && len(conns) > 0 {
				var connDetails []map[string]interface{}
				for _, c := range conns {
					if cm, ok := c.(map[string]interface{}); ok {
						detail := map[string]interface{}{}
						if ct, ok := cm["ConnectionType"].(map[string]interface{}); ok {
							detail["type"] = ct["Title"]
						}
						if kw, ok := cm["PowerKW"]; ok {
							detail["power_kw"] = kw
						}
						if qty, ok := cm["Quantity"]; ok {
							detail["quantity"] = qty
						}
						if st, ok := cm["StatusType"].(map[string]interface{}); ok {
							detail["status"] = st["Title"]
						}
						connDetails = append(connDetails, detail)
					}
				}
				info["connectors"] = connDetails
			}
			if usage, ok := m["UsageCost"]; ok && usage != nil {
				info["cost"] = usage
			}
			if st, ok := m["StatusType"].(map[string]interface{}); ok {
				info["status"] = st["Title"]
			}
			results = append(results, info)
		}
	}
	return map[string]interface{}{"stations": results, "count": len(results), "radius_km": radius}
}

// mcpEVNetworks returns info about major EV charging networks
func mcpEVNetworks(country string) interface{} {
	networks := map[string][]map[string]interface{}{
		"TR": {
			{"name": "Trugo (Togg)", "type": "DC Fast + AC", "connector": "CCS2, Type 2", "power": "up to 400kW", "website": "https://trugo.com.tr", "app": "Trugo", "note": "Togg's own charging network, rapidly expanding across Turkey"},
			{"name": "Eşarj", "type": "DC Fast + AC", "connector": "CCS2, CHAdeMO, Type 2", "power": "up to 180kW", "website": "https://esarj.com", "app": "Eşarj"},
			{"name": "ZES (Zorlu)", "type": "DC Fast + AC", "connector": "CCS2, CHAdeMO, Type 2", "power": "up to 150kW", "website": "https://zes.net", "app": "ZES"},
			{"name": "Sharz.net", "type": "DC Fast + AC", "connector": "CCS2, Type 2", "power": "up to 120kW", "website": "https://sharz.net", "app": "Sharz.net"},
			{"name": "Voltrun", "type": "DC Fast + AC", "connector": "CCS2, Type 2", "power": "up to 300kW", "website": "https://voltrun.com", "app": "Voltrun"},
			{"name": "Aksaenergy", "type": "DC Fast + AC", "connector": "CCS2, Type 2", "power": "up to 180kW", "website": "https://aksaenergy.com"},
		},
		"US": {
			{"name": "Tesla Supercharger", "type": "DC Fast", "connector": "NACS (Tesla), CCS1", "power": "up to 250kW", "website": "https://tesla.com/supercharger"},
			{"name": "Electrify America", "type": "DC Fast", "connector": "CCS1, CHAdeMO", "power": "up to 350kW", "website": "https://electrifyamerica.com"},
			{"name": "ChargePoint", "type": "DC Fast + AC", "connector": "CCS1, J1772", "power": "up to 350kW", "website": "https://chargepoint.com"},
			{"name": "EVgo", "type": "DC Fast", "connector": "CCS1, CHAdeMO", "power": "up to 350kW", "website": "https://evgo.com"},
			{"name": "Blink", "type": "DC Fast + AC", "connector": "CCS1, J1772", "power": "up to 150kW", "website": "https://blinkcharging.com"},
		},
		"EU": {
			{"name": "IONITY", "type": "DC Fast", "connector": "CCS2", "power": "up to 350kW", "website": "https://ionity.eu"},
			{"name": "Fastned", "type": "DC Fast", "connector": "CCS2, CHAdeMO", "power": "up to 300kW", "website": "https://fastnedcharging.com"},
			{"name": "Shell Recharge", "type": "DC Fast + AC", "connector": "CCS2, Type 2", "power": "up to 360kW", "website": "https://shell.com/recharge"},
			{"name": "BP Pulse", "type": "DC Fast + AC", "connector": "CCS2, Type 2", "power": "up to 300kW", "website": "https://bppulse.co.uk"},
			{"name": "Allego", "type": "DC Fast + AC", "connector": "CCS2, Type 2", "power": "up to 300kW", "website": "https://allego.eu"},
			{"name": "EnBW", "type": "DC Fast + AC", "connector": "CCS2, Type 2", "power": "up to 300kW", "website": "https://enbw.com/elektromobilitaet"},
		},
	}

	if country == "" {
		return map[string]interface{}{"networks": networks, "countries": []string{"TR", "US", "EU"}}
	}
	upper := strings.ToUpper(country)
	countryMap := map[string]string{"turkey": "TR", "usa": "US", "europe": "EU"}
	if mapped, ok := countryMap[strings.ToLower(country)]; ok {
		upper = mapped
	}
	if n, ok := networks[upper]; ok {
		return map[string]interface{}{"country": upper, "networks": n, "count": len(n)}
	}
	return map[string]interface{}{"error": "country not found. Available: TR, US, EU", "available": []string{"TR", "US", "EU"}}
}

// mcpEVConnectorTypes returns connector type reference
func mcpEVConnectorTypes() interface{} {
	return map[string]interface{}{
		"connectors": []map[string]interface{}{
			{"id": "1", "name": "Type 1 (J1772)", "region": "North America, Japan", "type": "AC", "max_power": "19.2kW"},
			{"id": "2", "name": "Type 2 (Mennekes)", "region": "Europe, Turkey", "type": "AC", "max_power": "43kW"},
			{"id": "25", "name": "Type 2 (Tesla Modified)", "region": "Europe (older Tesla)", "type": "AC/DC"},
			{"id": "32", "name": "CCS1 (Combo 1)", "region": "North America", "type": "DC", "max_power": "350kW"},
			{"id": "33", "name": "CCS2 (Combo 2)", "region": "Europe, Turkey, Australia", "type": "DC", "max_power": "350kW", "note": "Togg T10X uses CCS2"},
			{"id": "2", "name": "CHAdeMO", "region": "Japan (legacy)", "type": "DC", "max_power": "100kW"},
			{"id": "27", "name": "Tesla Supercharger (NACS)", "region": "North America", "type": "DC", "max_power": "250kW"},
			{"id": "30", "name": "Tesla (Type 2)", "region": "Europe (older)", "type": "DC"},
			{"id": "36", "name": "GB/T DC", "region": "China", "type": "DC", "max_power": "250kW"},
			{"id": "29", "name": "GB/T AC", "region": "China", "type": "AC"},
		},
		"note": "Use connector ID with ev_charging tool's connector_type parameter",
	}
}

// ---------------------------------------------------------------------------
// Nöbetçi Eczane — Turkey on-duty pharmacies
// ---------------------------------------------------------------------------

func mcpNobetciEczane(city, district string) interface{} {
	// nosyapi.com free API for nöbetçi eczane
	if city == "" {
		return map[string]interface{}{"error": "city required (e.g. istanbul, ankara, izmir)"}
	}
	city = strings.ToLower(city)

	// Try nosyapi
	u := fmt.Sprintf("https://www.nosyapi.com/apiv2/pharmacy?city=%s", url.QueryEscape(city))
	if district != "" {
		u += "&district=" + url.QueryEscape(strings.ToLower(district))
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(u)
	if err != nil {
		// Fallback: collectapi (free tier)
		return mcpNobetciEczaneFallback(city, district)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return mcpNobetciEczaneFallback(city, district)
	}

	body, _ := io.ReadAll(resp.Body)
	var result map[string]interface{}
	json.Unmarshal(body, &result)

	// Parse and simplify
	if data, ok := result["data"].([]interface{}); ok {
		var pharmacies []map[string]interface{}
		for _, p := range data {
			if pm, ok := p.(map[string]interface{}); ok {
				pharmacies = append(pharmacies, map[string]interface{}{
					"name":    pm["pharmacyName"],
					"address": pm["address"],
					"phone":   pm["phone"],
					"district": pm["dist"],
					"city":    pm["city"],
					"loc":     pm["loc"],
				})
			}
		}
		return map[string]interface{}{
			"pharmacies": pharmacies,
			"count":      len(pharmacies),
			"city":       city,
			"district":   district,
			"type":       "nöbetçi eczane (on-duty pharmacy)",
		}
	}
	return result
}

func mcpNobetciEczaneFallback(city, district string) interface{} {
	// Fallback: use collectapi free endpoint
	u := fmt.Sprintf("https://www.nosyapi.com/apiv2/pharmacy?city=%s", url.QueryEscape(city))
	if district != "" {
		u += "&district=" + url.QueryEscape(district)
	}

	// Another fallback: scrape from eczaneler.gen.tr via Google
	// For now return helpful info
	return map[string]interface{}{
		"city":    city,
		"note":    "API unavailable. Check manually:",
		"sources": []string{
			"https://www.eczaneler.gen.tr/nobetci-" + city,
			"https://www.google.com/search?q=nöbetçi+eczane+" + city,
			"https://www.turksaglik.com/nobetci-eczane/" + city,
		},
	}
}

func mcpEczaneSearch(lat, lon float64, radius int) interface{} {
	if radius <= 0 {
		radius = 2000
	}
	// Use Overpass API to find pharmacies from OpenStreetMap
	query := fmt.Sprintf(`[out:json][timeout:10];
node["amenity"="pharmacy"](around:%d,%f,%f);
out body 20;`, radius, lat, lon)

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Post("https://overpass-api.de/api/interpreter",
		"application/x-www-form-urlencoded",
		strings.NewReader("data="+url.QueryEscape(query)))
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	var result map[string]interface{}
	json.Unmarshal(body, &result)

	var pharmacies []map[string]interface{}
	if elements, ok := result["elements"].([]interface{}); ok {
		for _, e := range elements {
			if m, ok := e.(map[string]interface{}); ok {
				tags, _ := m["tags"].(map[string]interface{})
				pharmacies = append(pharmacies, map[string]interface{}{
					"name":       tags["name"],
					"phone":      tags["phone"],
					"website":    tags["website"],
					"address":    fmt.Sprintf("%v %v", tags["addr:street"], tags["addr:housenumber"]),
					"opening":    tags["opening_hours"],
					"wheelchair": tags["wheelchair"],
					"lat":        m["lat"],
					"lon":        m["lon"],
				})
			}
		}
	}
	return map[string]interface{}{"pharmacies": pharmacies, "count": len(pharmacies), "radius_m": radius}
}

// ---------------------------------------------------------------------------
// Places search — Nominatim/OpenStreetMap (FREE, no key)
// ---------------------------------------------------------------------------

func mcpPlacesSearch(query string, lat, lon float64) interface{} {
	u := fmt.Sprintf("https://nominatim.openstreetmap.org/search?q=%s&format=json&limit=10&addressdetails=1",
		url.QueryEscape(query))
	if lat != 0 && lon != 0 {
		u += fmt.Sprintf("&viewbox=%f,%f,%f,%f&bounded=1",
			lon-0.1, lat+0.1, lon+0.1, lat-0.1)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	req, _ := http.NewRequest("GET", u, nil)
	req.Header.Set("User-Agent", "Yaver-MCP/1.0")
	resp, err := client.Do(req)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	var places []interface{}
	json.Unmarshal(body, &places)

	var results []map[string]interface{}
	for _, p := range places {
		if m, ok := p.(map[string]interface{}); ok {
			results = append(results, map[string]interface{}{
				"name":    m["display_name"],
				"type":    m["type"],
				"lat":     m["lat"],
				"lon":     m["lon"],
				"address": m["address"],
			})
		}
	}
	return map[string]interface{}{"places": results, "query": query, "count": len(results)}
}

// ---------------------------------------------------------------------------
// Restaurants nearby — Overpass API (FREE, OpenStreetMap)
// ---------------------------------------------------------------------------

func mcpRestaurants(lat, lon float64, radius int, cuisine string) interface{} {
	if radius <= 0 {
		radius = 1000 // meters
	}

	query := fmt.Sprintf(`[out:json][timeout:10];
node["amenity"="restaurant"](around:%d,%f,%f);
out body 10;`, radius, lat, lon)

	if cuisine != "" {
		query = fmt.Sprintf(`[out:json][timeout:10];
node["amenity"="restaurant"]["cuisine"~"%s",i](around:%d,%f,%f);
out body 10;`, cuisine, radius, lat, lon)
	}

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Post("https://overpass-api.de/api/interpreter",
		"application/x-www-form-urlencoded",
		strings.NewReader("data="+url.QueryEscape(query)))
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	var result map[string]interface{}
	json.Unmarshal(body, &result)

	var restaurants []map[string]interface{}
	if elements, ok := result["elements"].([]interface{}); ok {
		for _, e := range elements {
			if m, ok := e.(map[string]interface{}); ok {
				tags, _ := m["tags"].(map[string]interface{})
				restaurants = append(restaurants, map[string]interface{}{
					"name":    tags["name"],
					"cuisine": tags["cuisine"],
					"phone":   tags["phone"],
					"website": tags["website"],
					"address": fmt.Sprintf("%v %v", tags["addr:street"], tags["addr:housenumber"]),
					"lat":     m["lat"],
					"lon":     m["lon"],
				})
			}
		}
	}
	return map[string]interface{}{"restaurants": restaurants, "count": len(restaurants), "radius_m": radius}
}

// ---------------------------------------------------------------------------
// Hotels nearby — Overpass API (FREE)
// ---------------------------------------------------------------------------

func mcpHotels(lat, lon float64, radius int) interface{} {
	if radius <= 0 {
		radius = 2000
	}

	query := fmt.Sprintf(`[out:json][timeout:10];
node["tourism"~"hotel|hostel|motel|guest_house"](around:%d,%f,%f);
out body 10;`, radius, lat, lon)

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Post("https://overpass-api.de/api/interpreter",
		"application/x-www-form-urlencoded",
		strings.NewReader("data="+url.QueryEscape(query)))
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	var result map[string]interface{}
	json.Unmarshal(body, &result)

	var hotels []map[string]interface{}
	if elements, ok := result["elements"].([]interface{}); ok {
		for _, e := range elements {
			if m, ok := e.(map[string]interface{}); ok {
				tags, _ := m["tags"].(map[string]interface{})
				hotels = append(hotels, map[string]interface{}{
					"name":    tags["name"],
					"type":    tags["tourism"],
					"stars":   tags["stars"],
					"phone":   tags["phone"],
					"website": tags["website"],
					"address": fmt.Sprintf("%v %v", tags["addr:street"], tags["addr:housenumber"]),
					"lat":     m["lat"],
					"lon":     m["lon"],
				})
			}
		}
	}
	return map[string]interface{}{"hotels": hotels, "count": len(hotels), "radius_m": radius}
}

// ---------------------------------------------------------------------------
// News — RSS feeds (FREE, no API key)
// ---------------------------------------------------------------------------

func mcpNews(source string) interface{} {
	feeds := map[string]string{
		"hackernews":  "https://hnrss.org/frontpage",
		"hn":          "https://hnrss.org/frontpage",
		"lobsters":    "https://lobste.rs/rss",
		"devto":       "https://dev.to/feed",
		"techcrunch":  "https://techcrunch.com/feed/",
		"verge":       "https://www.theverge.com/rss/index.xml",
		"ars":         "https://feeds.arstechnica.com/arstechnica/index",
		"reddit_prog": "https://www.reddit.com/r/programming/.rss",
	}

	feedURL, ok := feeds[strings.ToLower(source)]
	if !ok {
		// Treat as custom RSS URL
		if strings.HasPrefix(source, "http") {
			feedURL = source
		} else {
			return map[string]interface{}{
				"error":   "unknown source: " + source,
				"sources": []string{"hackernews", "lobsters", "devto", "techcrunch", "verge", "ars", "reddit_prog"},
				"note":    "Or pass any RSS feed URL",
			}
		}
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(feedURL)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	// Simple RSS parsing — extract titles and links
	content := string(body)
	var items []map[string]string
	parts := strings.Split(content, "<item>")
	if len(parts) <= 1 {
		parts = strings.Split(content, "<entry>")
	}
	for i, part := range parts {
		if i == 0 {
			continue
		}
		if len(items) >= 15 {
			break
		}
		title := extractTag(part, "title")
		link := extractTag(part, "link")
		if link == "" {
			// Atom format
			if idx := strings.Index(part, `href="`); idx >= 0 {
				rest := part[idx+6:]
				if end := strings.Index(rest, `"`); end >= 0 {
					link = rest[:end]
				}
			}
		}
		if title != "" {
			items = append(items, map[string]string{"title": title, "link": link})
		}
	}

	return map[string]interface{}{"source": source, "items": items, "count": len(items)}
}

func extractTag(xml, tag string) string {
	start := fmt.Sprintf("<%s>", tag)
	end := fmt.Sprintf("</%s>", tag)
	idx := strings.Index(xml, start)
	if idx < 0 {
		// Try CDATA
		start = fmt.Sprintf("<%s><![CDATA[", tag)
		end = fmt.Sprintf("]]></%s>", tag)
		idx = strings.Index(xml, start)
		if idx < 0 {
			return ""
		}
	}
	rest := xml[idx+len(start):]
	endIdx := strings.Index(rest, end)
	if endIdx < 0 {
		return ""
	}
	return strings.TrimSpace(rest[:endIdx])
}

// ---------------------------------------------------------------------------
// Stock prices — Yahoo Finance (FREE, no key)
// ---------------------------------------------------------------------------

func mcpStockPrice(symbol string) interface{} {
	// Use Yahoo Finance v8 API
	u := fmt.Sprintf("https://query1.finance.yahoo.com/v8/finance/chart/%s?interval=1d&range=5d",
		url.QueryEscape(strings.ToUpper(symbol)))

	client := &http.Client{Timeout: 10 * time.Second}
	req, _ := http.NewRequest("GET", u, nil)
	req.Header.Set("User-Agent", "Yaver-MCP/1.0")
	resp, err := client.Do(req)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	var data map[string]interface{}
	json.Unmarshal(body, &data)

	// Extract price
	if chart, ok := data["chart"].(map[string]interface{}); ok {
		if results, ok := chart["result"].([]interface{}); ok && len(results) > 0 {
			r := results[0].(map[string]interface{})
			meta := r["meta"].(map[string]interface{})
			return map[string]interface{}{
				"symbol":   meta["symbol"],
				"currency": meta["currency"],
				"price":    meta["regularMarketPrice"],
				"previous": meta["previousClose"],
				"exchange": meta["exchangeName"],
			}
		}
	}
	return map[string]interface{}{"error": "could not fetch price for " + symbol, "raw": string(body[:min(len(body), 200)])}
}

// ---------------------------------------------------------------------------
// Translation — premium (uses LibreTranslate self-hostable API)
// ---------------------------------------------------------------------------

func mcpTranslate(text, from, to, apiURL string) interface{} {
	if apiURL == "" {
		// Use free LibreTranslate instance
		apiURL = "https://libretranslate.com/translate"
	}
	if to == "" {
		to = "en"
	}
	if from == "" {
		from = "auto"
	}

	body := fmt.Sprintf(`{"q": %q, "source": %q, "target": %q}`, text, from, to)
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Post(apiURL, "application/json", strings.NewReader(body))
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	var result map[string]interface{}
	json.Unmarshal(respBody, &result)
	return result
}

// ---------------------------------------------------------------------------
// Geocode — coordinates from address (FREE, Nominatim)
// ---------------------------------------------------------------------------

func mcpGeocode(address string) interface{} {
	u := fmt.Sprintf("https://nominatim.openstreetmap.org/search?q=%s&format=json&limit=1",
		url.QueryEscape(address))
	client := &http.Client{Timeout: 10 * time.Second}
	req, _ := http.NewRequest("GET", u, nil)
	req.Header.Set("User-Agent", "Yaver-MCP/1.0")
	resp, err := client.Do(req)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var results []interface{}
	json.Unmarshal(body, &results)
	if len(results) == 0 {
		return map[string]interface{}{"error": "address not found"}
	}
	m := results[0].(map[string]interface{})
	return map[string]interface{}{
		"address": m["display_name"],
		"lat":     m["lat"],
		"lon":     m["lon"],
	}
}

// ---------------------------------------------------------------------------
// Directions / distance (FREE, OSRM)
// ---------------------------------------------------------------------------

func mcpDirections(fromLat, fromLon, toLat, toLon float64) interface{} {
	u := fmt.Sprintf("https://router.project-osrm.org/route/v1/driving/%f,%f;%f,%f?overview=false&steps=false",
		fromLon, fromLat, toLon, toLat)
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(u)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var result map[string]interface{}
	json.Unmarshal(body, &result)

	if routes, ok := result["routes"].([]interface{}); ok && len(routes) > 0 {
		route := routes[0].(map[string]interface{})
		distKm := route["distance"].(float64) / 1000
		durMin := route["duration"].(float64) / 60
		return map[string]interface{}{
			"distance_km": fmt.Sprintf("%.1f", distKm),
			"duration_min": fmt.Sprintf("%.0f", durMin),
		}
	}
	return map[string]interface{}{"error": "could not calculate route"}
}
