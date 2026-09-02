package main

import "testing"

func TestWireIOSBuildHeadroomCountsReusableDerivedDataStandalone(t *testing.T) {
	if hasWireIOSBuildHeadroom(8<<30, 0) {
		t.Fatal("a cold build with only 8 GiB free must fail the 10 GiB floor")
	}
	if !hasWireIOSBuildHeadroom(9<<30, 1<<30) {
		t.Fatal("a warm build must count its existing reusable DerivedData")
	}
	if hasWireIOSBuildHeadroom(1<<30, 20<<30) {
		t.Fatal("reusable DerivedData must not mask an almost-full volume")
	}
}
