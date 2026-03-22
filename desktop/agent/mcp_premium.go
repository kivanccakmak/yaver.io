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

func mcpEVCharging(lat, lon float64, radius int, connectorType string) interface{} {
	if radius <= 0 {
		radius = 10 // km
	}
	// OpenChargeMap is free and open
	u := fmt.Sprintf("https://api.openchargemap.io/v3/poi/?output=json&latitude=%f&longitude=%f&distance=%d&distanceunit=KM&maxresults=10&compact=true&verbose=false",
		lat, lon, radius)
	if connectorType != "" {
		u += "&connectiontypeid=" + connectorType
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

	// Simplify output
	var results []map[string]interface{}
	for _, s := range stations {
		if m, ok := s.(map[string]interface{}); ok {
			info := map[string]interface{}{}
			if ai, ok := m["AddressInfo"].(map[string]interface{}); ok {
				info["title"] = ai["Title"]
				info["address"] = ai["AddressLine1"]
				info["town"] = ai["Town"]
				info["distance_km"] = ai["Distance"]
				info["latitude"] = ai["Latitude"]
				info["longitude"] = ai["Longitude"]
			}
			if conns, ok := m["Connections"].([]interface{}); ok && len(conns) > 0 {
				var connTypes []string
				for _, c := range conns {
					if cm, ok := c.(map[string]interface{}); ok {
						if ct, ok := cm["ConnectionType"].(map[string]interface{}); ok {
							connTypes = append(connTypes, fmt.Sprintf("%v", ct["Title"]))
						}
					}
				}
				info["connectors"] = connTypes
			}
			if usage, ok := m["UsageCost"]; ok && usage != nil {
				info["cost"] = usage
			}
			info["status"] = m["StatusType"]
			results = append(results, info)
		}
	}
	return map[string]interface{}{"stations": results, "count": len(results), "radius_km": radius}
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
