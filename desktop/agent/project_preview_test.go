package main

import (
	"reflect"
	"testing"
)

func TestPreviewCommandSelectsFrameworkAdapter(t *testing.T) {
	tests := []struct {
		name      string
		manifest  packageManifest
		framework string
		command   string
		args      []string
	}{
		{
			name: "expo web script",
			manifest: packageManifest{
				Scripts:      map[string]string{"web": "expo start --web"},
				Dependencies: map[string]string{"expo": "latest"},
			},
			framework: "Expo",
			command:   "npm",
			args:      []string{"run", "web", "--", "--port", "4321"},
		},
		{
			name: "next",
			manifest: packageManifest{
				Scripts:      map[string]string{"dev": "next dev"},
				Dependencies: map[string]string{"next": "latest"},
			},
			framework: "Next.js",
			command:   "npm",
			args:      []string{"run", "dev", "--", "--hostname", "127.0.0.1", "--port", "4321"},
		},
		{
			name: "vite",
			manifest: packageManifest{
				Scripts:         map[string]string{"dev": "vite"},
				DevDependencies: map[string]string{"vite": "latest"},
			},
			framework: "Vite",
			command:   "npm",
			args:      []string{"run", "dev", "--", "--host", "127.0.0.1", "--port", "4321"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			framework, command, args, err := previewCommand(test.manifest, 4321)
			if err != nil {
				t.Fatal(err)
			}
			if framework != test.framework || command != test.command || !reflect.DeepEqual(args, test.args) {
				t.Fatalf("got %q %q %#v", framework, command, args)
			}
		})
	}
}

func TestPreviewCommandRejectsUnsupportedProject(t *testing.T) {
	if _, _, _, err := previewCommand(packageManifest{}, 4321); err == nil {
		t.Fatal("expected unsupported project error")
	}
}
