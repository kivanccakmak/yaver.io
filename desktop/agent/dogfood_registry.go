package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
)

type DogfoodApp struct {
	ID             string   `json:"_id"`
	AppID          string   `json:"appId"`
	Label          string   `json:"label"`
	ProjectSlug    string   `json:"projectSlug,omitempty"`
	TargetDeviceID string   `json:"targetDeviceId,omitempty"`
	ActivationURL  string   `json:"activationUrl,omitempty"`
	AllowedScopes  []string `json:"allowedScopes"`
	Enabled        bool     `json:"enabled"`
}

type DogfoodAppPatch struct {
	ProjectSlug    *string
	TargetDeviceID *string
	ActivationURL  *string
	AllowedScopes  *[]string
	Enabled        *bool
}

func mergeDogfoodAppPatch(appID, label string, existing []DogfoodApp, patch DogfoodAppPatch) DogfoodApp {
	result := DogfoodApp{AppID: appID, Label: label, AllowedScopes: []string{"feedback", "blackbox"}, Enabled: true}
	for _, app := range existing {
		if app.AppID == appID {
			result = app
			result.Label = label
			break
		}
	}
	if patch.ProjectSlug != nil {
		result.ProjectSlug = *patch.ProjectSlug
	}
	if patch.TargetDeviceID != nil {
		result.TargetDeviceID = *patch.TargetDeviceID
	}
	if patch.ActivationURL != nil {
		result.ActivationURL = *patch.ActivationURL
	}
	if patch.AllowedScopes != nil {
		result.AllowedScopes = *patch.AllowedScopes
	}
	if patch.Enabled != nil {
		result.Enabled = *patch.Enabled
	}
	return result
}

type DogfoodInstallation struct {
	ID              string `json:"_id"`
	AppID           string `json:"appId"`
	InstallationID  string `json:"installationId"`
	Platform        string `json:"platform"`
	Label           string `json:"label,omitempty"`
	Status          string `json:"status"`
	ProofVerifiedAt int64  `json:"proofVerifiedAt,omitempty"`
	Tester          *struct {
		Name  string `json:"name"`
		Email string `json:"email"`
	} `json:"tester,omitempty"`
}

func dogfoodRegistryJSON(method, path string, payload interface{}, out interface{}) error {
	cfg, err := LoadConfig()
	if err != nil || cfg == nil || cfg.AuthToken == "" {
		return fmt.Errorf("not signed in — run `yaver auth`")
	}
	baseURL := cfg.ConvexSiteURL
	if baseURL == "" {
		baseURL = defaultConvexSiteURL
	}
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		body = bytes.NewReader(encoded)
	}
	req, err := newBearerRequest(method, strings.TrimRight(baseURL, "/")+path, cfg.AuthToken, body)
	if err != nil {
		return err
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message, _ := io.ReadAll(response.Body)
		return fmt.Errorf("dogfood registry failed (HTTP %d): %s", response.StatusCode, strings.TrimSpace(string(message)))
	}
	if out != nil {
		return json.NewDecoder(response.Body).Decode(out)
	}
	return nil
}

func listDogfoodRegistryApps() ([]DogfoodApp, error) {
	var response struct {
		Apps []DogfoodApp `json:"apps"`
	}
	err := dogfoodRegistryJSON(http.MethodGet, "/dogfood/apps", nil, &response)
	return response.Apps, err
}

func saveDogfoodRegistryApp(app DogfoodApp) (DogfoodApp, error) {
	var response struct {
		App DogfoodApp `json:"app"`
	}
	err := dogfoodRegistryJSON(http.MethodPost, "/dogfood/apps", app, &response)
	return response.App, err
}

func listDogfoodRegistryInstallations(appID string) ([]DogfoodInstallation, error) {
	path := "/dogfood/installations"
	if appID != "" {
		path += "?appId=" + url.QueryEscape(appID)
	}
	var response struct {
		Installations []DogfoodInstallation `json:"installations"`
	}
	err := dogfoodRegistryJSON(http.MethodGet, path, nil, &response)
	return response.Installations, err
}

func setDogfoodRegistryInstallation(id, action string) (map[string]interface{}, error) {
	var response map[string]interface{}
	err := dogfoodRegistryJSON(http.MethodPost, "/dogfood/installations/action", map[string]string{"installationId": id, "action": action}, &response)
	return response, err
}

func runDogfoodRegistry(args []string) {
	if len(args) == 0 {
		printDogfoodRegistryUsage()
		return
	}
	var result interface{}
	var err error
	switch args[0] {
	case "apps":
		result, err = listDogfoodRegistryApps()
	case "app-set":
		fs := flag.NewFlagSet("dogfood app-set", flag.ExitOnError)
		appID := fs.String("app", "", "Public app id")
		label := fs.String("label", "", "App label")
		project := fs.String("project", "", "Allowed project slug")
		target := fs.String("device", "", "Target Yaver device id")
		scopes := fs.String("scopes", "feedback,blackbox", "Comma-separated capabilities")
		disabled := fs.Bool("disabled", false, "Disable new sessions")
		_ = fs.Parse(args[1:])
		if *appID == "" || *label == "" {
			fmt.Fprintln(os.Stderr, "--app and --label are required")
			os.Exit(2)
		}
		result, err = saveDogfoodRegistryApp(DogfoodApp{AppID: *appID, Label: *label, ProjectSlug: *project, TargetDeviceID: *target, AllowedScopes: splitNonEmpty(*scopes), Enabled: !*disabled})
	case "installations":
		fs := flag.NewFlagSet("dogfood installations", flag.ExitOnError)
		appID := fs.String("app", "", "Filter by app id")
		_ = fs.Parse(args[1:])
		result, err = listDogfoodRegistryInstallations(*appID)
	case "approve", "cancel", "revoke":
		if len(args) != 2 {
			fmt.Fprintf(os.Stderr, "usage: yaver dogfood %s <installation-doc-id>\n", args[0])
			os.Exit(2)
		}
		result, err = setDogfoodRegistryInstallation(args[1], args[0])
	default:
		printDogfoodRegistryUsage()
		return
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	encoded, _ := json.MarshalIndent(result, "", "  ")
	fmt.Println(string(encoded))
}

func splitNonEmpty(value string) []string {
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func printDogfoodRegistryUsage() {
	fmt.Print(`Manage Yaver-account-bound third-party Dogfood installations.

  yaver dogfood apps
  yaver dogfood app-set --app io.example.app --label Example --project example
  yaver dogfood installations [--app io.example.app]
  yaver dogfood approve|cancel|revoke <installation-doc-id>
`)
}
