package main

import "testing"

func TestMergeDogfoodAppPatchPreservesOmittedPolicy(t *testing.T) {
	existing := []DogfoodApp{{
		AppID: "com.example.sfmg", Label: "Old", ProjectSlug: "sfmg",
		TargetDeviceID: "ubuntu-runner", ActivationURL: "yaver-dogfood-com.example.sfmg://activate",
		AllowedScopes: []string{"feedback", "blackbox", "reload"}, Enabled: false,
	}}

	got := mergeDogfoodAppPatch("com.example.sfmg", "SFMG", existing, DogfoodAppPatch{})
	if got.ProjectSlug != "sfmg" || got.TargetDeviceID != "ubuntu-runner" || got.ActivationURL == "" {
		t.Fatalf("omitted routing fields were lost: %#v", got)
	}
	if got.Enabled {
		t.Fatal("an omitted enabled field re-enabled a disabled app")
	}
	if len(got.AllowedScopes) != 3 || got.AllowedScopes[2] != "reload" {
		t.Fatalf("omitted scopes were overwritten: %#v", got.AllowedScopes)
	}
}

func TestMergeDogfoodAppPatchAppliesExplicitClear(t *testing.T) {
	empty := ""
	existing := []DogfoodApp{{AppID: "com.example.sfmg", Label: "SFMG", ProjectSlug: "sfmg", Enabled: true}}
	got := mergeDogfoodAppPatch("com.example.sfmg", "SFMG", existing, DogfoodAppPatch{ProjectSlug: &empty})
	if got.ProjectSlug != "" {
		t.Fatalf("explicit clear did not apply: %#v", got)
	}
}
