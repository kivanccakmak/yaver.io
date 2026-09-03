package main

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeExpoIntegrationFixture(t *testing.T, rootRel, rootSource string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"dependencies":{"expo":"~57.0.0","react":"19.2.0","react-native":"0.86.0"}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "app.json"), []byte(`{"expo":{"name":"clean-room","slug":"clean-room"}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	rootPath := filepath.Join(dir, filepath.FromSlash(rootRel))
	if err := os.MkdirAll(filepath.Dir(rootPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(rootPath, []byte(rootSource), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestIntegrateExpoClassicRootIsCompleteAndIdempotent(t *testing.T) {
	dir := writeExpoIntegrationFixture(t, "App.tsx", `import { Text, View } from 'react-native';

export default function App() {
  return <View><Text>Hello</Text></View>;
}
`)

	first, err := integrateProject(projectIntegrationOptions{
		Directory:   dir,
		Framework:   "expo",
		Verify:      "none",
		SkipInstall: true,
	}, io.Discard)
	if err != nil {
		t.Fatalf("first integration failed: %v", err)
	}
	if !first.OK {
		t.Fatalf("first integration did not report ok: %#v", first)
	}
	root, _ := os.ReadFile(filepath.Join(dir, "App.tsx"))
	rootText := string(root)
	for _, want := range []string{
		"import { withYaverFeedback } from './yaver/YaverFeedbackRoot';",
		"function App()",
		"export default withYaverFeedback(App);",
	} {
		if !strings.Contains(rootText, want) {
			t.Fatalf("patched root missing %q:\n%s", want, rootText)
		}
	}
	integration, err := os.ReadFile(filepath.Join(dir, yaverIntegrationFile))
	if err != nil {
		t.Fatalf("generated integration file missing: %v", err)
	}
	for _, want := range []string{"initExpo();", "<FeedbackModal />", "withYaverFeedback"} {
		if !strings.Contains(string(integration), want) {
			t.Fatalf("integration file missing %q", want)
		}
	}
	assertExpoPluginCount(t, filepath.Join(dir, "app.json"), 1)

	rootBefore := rootText
	integrationBefore := string(integration)
	second, err := integrateProject(projectIntegrationOptions{
		Directory:   dir,
		Framework:   "expo",
		Verify:      "none",
		SkipInstall: true,
	}, io.Discard)
	if err != nil {
		t.Fatalf("second integration failed: %v", err)
	}
	if len(second.ChangedFiles) != 0 {
		t.Fatalf("idempotent rerun changed files: %v", second.ChangedFiles)
	}
	rootAfter, _ := os.ReadFile(filepath.Join(dir, "App.tsx"))
	integrationAfter, _ := os.ReadFile(filepath.Join(dir, yaverIntegrationFile))
	if string(rootAfter) != rootBefore || string(integrationAfter) != integrationBefore {
		t.Fatal("idempotent rerun changed generated source")
	}
	assertExpoPluginCount(t, filepath.Join(dir, "app.json"), 1)
}

func TestIntegrateExpoRouterRoot(t *testing.T) {
	dir := writeExpoIntegrationFixture(t, "app/_layout.tsx", `import { Stack } from 'expo-router';

export default function RootLayout() {
  return <Stack />;
}
`)
	result, err := integrateProject(projectIntegrationOptions{
		Directory:   dir,
		Verify:      "none",
		SkipInstall: true,
	}, io.Discard)
	if err != nil {
		t.Fatalf("router integration failed: %v", err)
	}
	if result.RootFile != "app/_layout.tsx" {
		t.Fatalf("wrong router root: %s", result.RootFile)
	}
	root, _ := os.ReadFile(filepath.Join(dir, "app/_layout.tsx"))
	if !strings.Contains(string(root), "from '../yaver/YaverFeedbackRoot'") ||
		!strings.Contains(string(root), "export default withYaverFeedback(RootLayout);") {
		t.Fatalf("router root was not wrapped:\n%s", root)
	}
}

func TestIntegrateExpoNamedDefaultValue(t *testing.T) {
	dir := writeExpoIntegrationFixture(t, "App.tsx", `import { Text } from 'react-native';
const App = () => <Text>Hello</Text>;
export default App;
`)
	_, err := integrateProject(projectIntegrationOptions{
		Directory:   dir,
		Verify:      "none",
		SkipInstall: true,
	}, io.Discard)
	if err != nil {
		t.Fatalf("named value integration failed: %v", err)
	}
	root, _ := os.ReadFile(filepath.Join(dir, "App.tsx"))
	if !strings.Contains(string(root), "export default withYaverFeedback(App);") {
		t.Fatalf("named default value was not wrapped:\n%s", root)
	}
}

func TestIntegrateExpoFailsBeforeMutationForAnonymousRoot(t *testing.T) {
	dir := writeExpoIntegrationFixture(t, "App.tsx", `export default () => null;
`)
	appBefore, _ := os.ReadFile(filepath.Join(dir, "app.json"))
	_, err := integrateProject(projectIntegrationOptions{
		Directory:   dir,
		Verify:      "none",
		SkipInstall: true,
	}, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "named root component") {
		t.Fatalf("expected named-root remedy, got %v", err)
	}
	appAfter, _ := os.ReadFile(filepath.Join(dir, "app.json"))
	if string(appBefore) != string(appAfter) {
		t.Fatal("failed preflight mutated app.json")
	}
	if _, statErr := os.Stat(filepath.Join(dir, yaverIntegrationFile)); !os.IsNotExist(statErr) {
		t.Fatalf("failed preflight created integration file: %v", statErr)
	}
}

func TestAddPluginToAppJSONRecognizesConfiguredEntry(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "app.json")
	if err := os.WriteFile(path, []byte(`{"expo":{"plugins":[["yaver-feedback-react-native",{"enableHotReload":true}]]}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := addPluginToAppJSON(path); err != nil {
		t.Fatal(err)
	}
	assertExpoPluginCount(t, path, 1)
}

func TestYaverSDKIntegrateMCPRunsTheSameEngine(t *testing.T) {
	dir := writeExpoIntegrationFixture(t, "App.tsx", `export default function App() {
  return null;
}
`)
	args, err := json.Marshal(map[string]interface{}{
		"name": "yaver_sdk_integrate",
		"arguments": map[string]interface{}{
			"directory":    dir,
			"verify":       "none",
			"skip_install": true,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	text := billingToolText(t, (&HTTPServer{}).handleMCPToolCall(args))
	for _, want := range []string{`"ok": true`, `"root_file": "App.tsx"`, `"integration_file": "yaver/YaverFeedbackRoot.tsx"`} {
		if !strings.Contains(text, want) {
			t.Fatalf("MCP integration result missing %s:\n%s", want, text)
		}
	}
}

func TestYaverSDKIntegrateIsAdvertised(t *testing.T) {
	wrapper := (&HTTPServer{}).getMCPToolsList().(map[string]interface{})
	tools := wrapper["tools"].([]map[string]interface{})
	for _, tool := range tools {
		if tool["name"] == "yaver_sdk_integrate" {
			return
		}
	}
	t.Fatal("yaver_sdk_integrate is dispatched but not advertised")
}

func assertExpoPluginCount(t *testing.T, path string, want int) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]interface{}
	if err := json.Unmarshal(data, &config); err != nil {
		t.Fatal(err)
	}
	expo := config["expo"].(map[string]interface{})
	plugins := expo["plugins"].([]interface{})
	count := 0
	for _, plugin := range plugins {
		switch value := plugin.(type) {
		case string:
			if value == yaverIntegrationPackage {
				count++
			}
		case []interface{}:
			if len(value) > 0 && value[0] == yaverIntegrationPackage {
				count++
			}
		}
	}
	if count != want {
		t.Fatalf("expected %d Yaver plugin entries, got %d in %v", want, count, plugins)
	}
}
