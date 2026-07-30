package main

import "testing"

func TestBuildRedroidResourceStatusUnsupportedHost(t *testing.T) {
	st := buildRedroidResourceStatus(redroidResourceProbe{
		OS:             "darwin",
		Arch:           "arm64",
		DefaultWorkDir: "/tmp/redroid",
	})
	if st.Ready || st.CanHostHere {
		t.Fatalf("darwin host must not be ready: %+v", st)
	}
	if st.State != "unsupported_host" {
		t.Fatalf("state = %q, want unsupported_host", st.State)
	}
	if !st.Dedicated {
		t.Fatal("redroid resource should be marked dedicated")
	}
}

func TestBuildRedroidResourceStatusDockerMissing(t *testing.T) {
	st := buildRedroidResourceStatus(redroidResourceProbe{OS: "linux", Arch: "arm64"})
	if st.State != "docker_missing" {
		t.Fatalf("state = %q, want docker_missing", st.State)
	}
	if len(st.NextActions) == 0 {
		t.Fatal("missing next actions")
	}
}

func TestBuildRedroidResourceStatusDockerUnreachable(t *testing.T) {
	st := buildRedroidResourceStatus(redroidResourceProbe{
		OS:            "linux",
		Arch:          "amd64",
		DockerPresent: true,
		DockerDetail:  "Cannot connect to the Docker daemon",
	})
	if st.State != "docker_unreachable" {
		t.Fatalf("state = %q, want docker_unreachable", st.State)
	}
	if st.Ready {
		t.Fatal("unreachable Docker must not be ready")
	}
}

func TestBuildRedroidResourceStatusImageMissing(t *testing.T) {
	st := buildRedroidResourceStatus(redroidResourceProbe{
		OS:              "linux",
		Arch:            "arm64",
		DockerPresent:   true,
		DockerReachable: true,
		BinderDevices:   true,
		FreeBytes:       minRedroidFreeBytes,
	})
	if st.State != "image_missing" {
		t.Fatalf("state = %q, want image_missing", st.State)
	}
}

func TestBuildRedroidResourceStatusBinderMissing(t *testing.T) {
	st := buildRedroidResourceStatus(redroidResourceProbe{
		OS:                  "linux",
		Arch:                "arm64",
		DockerPresent:       true,
		DockerReachable:     true,
		RedroidImagePresent: true,
		BinderDetail:        "binder_linux module not found",
		FreeBytes:           minRedroidFreeBytes,
	})
	if st.State != "binder_missing" {
		t.Fatalf("state = %q, want binder_missing", st.State)
	}
	if st.Ready || st.CanHostHere {
		t.Fatalf("binder-missing host must not be ready: %+v", st)
	}
	if st.Summary == "" || len(st.NextActions) == 0 {
		t.Fatalf("binder failure must carry a route: %+v", st)
	}
}

func TestBuildRedroidResourceStatusDiskTooLow(t *testing.T) {
	st := buildRedroidResourceStatus(redroidResourceProbe{
		OS:                  "linux",
		Arch:                "arm64",
		DockerPresent:       true,
		DockerReachable:     true,
		RedroidImagePresent: true,
		BinderDevices:       true,
		FreeBytes:           minRedroidFreeBytes - 1,
	})
	if st.State != "disk_too_low" {
		t.Fatalf("state = %q, want disk_too_low", st.State)
	}
	if st.Ready || st.CanHostHere {
		t.Fatalf("disk-low host must not be ready: %+v", st)
	}
}

func TestBuildRedroidResourceStatusReady(t *testing.T) {
	st := buildRedroidResourceStatus(redroidResourceProbe{
		OS:                  "linux",
		Arch:                "arm64",
		DockerPresent:       true,
		DockerReachable:     true,
		RedroidImagePresent: true,
		BinderDevices:       true,
		FreeBytes:           minRedroidFreeBytes,
	})
	if !st.Ready || !st.CanHostHere {
		t.Fatalf("ready host not marked ready: %+v", st)
	}
	if st.State != "ready" {
		t.Fatalf("state = %q, want ready", st.State)
	}
}
