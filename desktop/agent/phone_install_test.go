package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPhoneWebInstallPreflightFailsUntilOperationIsRenderable(t *testing.T) {
	setupPhoneTestHome(t)
	p, err := CreatePhoneProject(PhoneCreateSpec{Name: "No Tables", Schema: &PhoneSchema{Tables: []PhoneTable{}}, App: &PhoneAppSpec{}})
	if err != nil {
		t.Fatal(err)
	}
	pre, err := PreflightPhoneWebApp(p.Slug, nil)
	if err != nil {
		t.Fatal(err)
	}
	if pre.OK || pre.Code != "web_install_schema_missing" || pre.Remedy == nil {
		t.Fatalf("expected named failure with remedy, got %#v", pre)
	}
	if _, err := PublishPhoneWebApp(p.Slug, nil); err == nil {
		t.Fatal("publish reported success even though the real render preflight failed")
	}

	schema := templateSchema("todos")
	if err := ApplyPhoneSchema(p.Slug, schema); err != nil {
		t.Fatal(err)
	}
	pre, err = PreflightPhoneWebApp(p.Slug, nil)
	if err != nil || !pre.OK {
		t.Fatalf("preflight did not recover after applying a renderable schema: %#v, %v", pre, err)
	}
}

func TestPhoneWebInstallPublishesManifestIconAndNoHostPath(t *testing.T) {
	setupPhoneTestHome(t)
	p, err := CreatePhoneProject(PhoneCreateSpec{
		Name:     "Pocket Tasks",
		Template: "todos",
		App: &PhoneAppSpec{PrimaryEntity: "todos", Brand: &PhoneAppBrand{
			DisplayName: "Pocket Done", Icon: "check", Palette: "forest",
			PrimaryColor: "#00B894", SecondaryColor: "#55EFC4",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	st, err := PublishPhoneWebApp(p.Slug, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !st.Published || st.AppPath != "/apps/pocket-tasks/" || st.Brand.Icon != "check" {
		t.Fatalf("unexpected status: %#v", st)
	}

	srv := &HTTPServer{}
	mux := http.NewServeMux()
	srv.registerPhoneRoutes(mux)

	manifest := httptest.NewRecorder()
	mux.ServeHTTP(manifest, httptest.NewRequest(http.MethodGet, st.AppPath+"manifest.webmanifest", nil))
	if manifest.Code != http.StatusOK || !strings.Contains(manifest.Body.String(), `"name":"Pocket Done"`) {
		t.Fatalf("manifest status/body: %d %s", manifest.Code, manifest.Body.String())
	}
	if strings.Contains(manifest.Body.String(), "token") || strings.Contains(manifest.Body.String(), "api_key") {
		t.Fatalf("manifest leaked an auth transport: %s", manifest.Body.String())
	}

	icon := httptest.NewRecorder()
	mux.ServeHTTP(icon, httptest.NewRequest(http.MethodGet, st.AppPath+"icon-180.png", nil))
	if icon.Code != http.StatusOK || icon.Header().Get("Content-Type") != "image/png" || !bytes.HasPrefix(icon.Body.Bytes(), []byte("\x89PNG")) {
		t.Fatalf("icon was not a real PNG: %d %q", icon.Code, icon.Header().Get("Content-Type"))
	}

	release := httptest.NewRecorder()
	mux.ServeHTTP(release, httptest.NewRequest(http.MethodGet, st.AppPath+"release.json", nil))
	if release.Code != http.StatusOK {
		t.Fatalf("release status %d: %s", release.Code, release.Body.String())
	}
	if strings.Contains(release.Body.String(), p.Dir) || strings.Contains(release.Body.String(), `"dir":"/`) {
		t.Fatalf("public release leaked a host path: %s", release.Body.String())
	}
}

func TestPhoneWebEnrollmentDeliversOneScopedToken(t *testing.T) {
	setupPhoneTestHome(t)
	p, err := CreatePhoneProject(PhoneCreateSpec{Name: "Enroll", Template: "todos"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := PublishPhoneWebApp(p.Slug, nil); err != nil {
		t.Fatal(err)
	}

	start := httptest.NewRecorder()
	startPhoneWebEnrollment(start, httptest.NewRequest(http.MethodPost, "/apps/enroll/enroll/start", nil), p.Slug)
	if start.Code != http.StatusOK {
		t.Fatalf("start: %d %s", start.Code, start.Body.String())
	}
	var enrollment struct{ ID, Secret, Code string }
	if err := json.Unmarshal(start.Body.Bytes(), &enrollment); err != nil {
		t.Fatal(err)
	}
	if enrollment.ID == "" || enrollment.Secret == "" || enrollment.Code == "" {
		t.Fatalf("incomplete enrollment: %#v", enrollment)
	}
	if got := listPhoneWebEnrollments(p.Slug); len(got) != 1 || got[0]["code"] != enrollment.Code {
		t.Fatalf("owner cannot see pending code: %#v", got)
	}
	if err := approvePhoneWebEnrollment(p.Slug, enrollment.Code); err != nil {
		t.Fatal(err)
	}

	pollBody, _ := json.Marshal(map[string]string{"id": enrollment.ID, "secret": enrollment.Secret})
	poll := httptest.NewRecorder()
	pollPhoneWebEnrollment(poll, httptest.NewRequest(http.MethodPost, "/apps/enroll/enroll/poll", bytes.NewReader(pollBody)), p.Slug)
	if poll.Code != http.StatusOK {
		t.Fatalf("poll: %d %s", poll.Code, poll.Body.String())
	}
	var approved struct{ Status, Token string }
	if err := json.Unmarshal(poll.Body.Bytes(), &approved); err != nil {
		t.Fatal(err)
	}
	if approved.Status != "approved" || !strings.HasPrefix(approved.Token, "pp_"+p.Slug+"_") {
		t.Fatalf("not a project-scoped token: %#v", approved)
	}
	if _, boundSlug, err := ValidatePhoneProjectToken(approved.Token); err != nil || boundSlug != p.Slug {
		t.Fatalf("issued token invalid or cross-bound: %q %v", boundSlug, err)
	}

	second := httptest.NewRecorder()
	pollPhoneWebEnrollment(second, httptest.NewRequest(http.MethodPost, "/apps/enroll/enroll/poll", bytes.NewReader(pollBody)), p.Slug)
	if second.Code != http.StatusUnauthorized {
		t.Fatalf("token was delivered more than once: %d %s", second.Code, second.Body.String())
	}
}

func TestPhoneWebInstallRollbackRestoresLastGoodRelease(t *testing.T) {
	setupPhoneTestHome(t)
	p, err := CreatePhoneProject(PhoneCreateSpec{Name: "Rollback", Template: "todos"})
	if err != nil {
		t.Fatal(err)
	}
	first, err := PublishPhoneWebApp(p.Slug, &PhoneAppBrand{DisplayName: "First", Icon: "note"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := PublishPhoneWebApp(p.Slug, &PhoneAppBrand{DisplayName: "Second", Icon: "rocket"})
	if err != nil {
		t.Fatal(err)
	}
	if first.ActiveRelease == second.ActiveRelease || !second.CanRollback {
		t.Fatalf("publish did not retain last good release: %#v %#v", first, second)
	}
	rolled, err := RollbackPhoneWebApp(p.Slug)
	if err != nil {
		t.Fatal(err)
	}
	if rolled.ActiveRelease != first.ActiveRelease || rolled.Brand.DisplayName != "First" {
		t.Fatalf("rollback restored wrong release: %#v", rolled)
	}
}
