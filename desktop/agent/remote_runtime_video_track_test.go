package main

import (
	"context"
	"io"
	"strings"
	"testing"

	"github.com/pion/webrtc/v4"
)

type sliceNALSource struct {
	nals []NALUnit
	i    int
}

func (s *sliceNALSource) Next(context.Context) (NALUnit, error) {
	if s.i >= len(s.nals) {
		return NALUnit{}, io.EOF
	}
	nal := s.nals[s.i]
	s.i++
	return nal, nil
}

func TestAccessUnitReaderGroupsParameterSetsWithFrame(t *testing.T) {
	src := &sliceNALSource{nals: []NALUnit{
		{Data: []byte{0x09, 0xf0}, Type: 9}, // AUD for frame 1
		{Data: []byte{0x67, 0x01}, Type: 7}, // SPS
		{Data: []byte{0x68, 0x02}, Type: 8}, // PPS
		{Data: []byte{0x65, 0x03}, Type: 5}, // IDR slice
		{Data: []byte{0x09, 0xf0}, Type: 9}, // AUD for frame 2: starts next AU
		{Data: []byte{0x41, 0x04}, Type: 1}, // non-IDR slice
		{Data: []byte{0x67, 0x05}, Type: 7}, // next frame's SPS: must not trail frame 2
		{Data: []byte{0x68, 0x06}, Type: 8}, // next frame's PPS
		{Data: []byte{0x65, 0x07}, Type: 5}, // next IDR
	}}
	r := newAccessUnitReader(src)

	first, err := r.Next(context.Background())
	if err != nil {
		t.Fatalf("first AU: %v", err)
	}
	wantFirst := []byte{
		0, 0, 1, 0x09, 0xf0,
		0, 0, 1, 0x67, 0x01,
		0, 0, 1, 0x68, 0x02,
		0, 0, 1, 0x65, 0x03,
	}
	if string(first) != string(wantFirst) {
		t.Fatalf("first AU bytes = %v, want %v", first, wantFirst)
	}

	second, err := r.Next(context.Background())
	if err != nil {
		t.Fatalf("second AU: %v", err)
	}
	wantSecond := []byte{
		0, 0, 1, 0x09, 0xf0,
		0, 0, 1, 0x41, 0x04,
	}
	if string(second) != string(wantSecond) {
		t.Fatalf("second AU bytes = %v, want %v", second, wantSecond)
	}

	third, err := r.Next(context.Background())
	if err != nil {
		t.Fatalf("third AU: %v", err)
	}
	wantThird := []byte{
		0, 0, 1, 0x67, 0x05,
		0, 0, 1, 0x68, 0x06,
		0, 0, 1, 0x65, 0x07,
	}
	if string(third) != string(wantThird) {
		t.Fatalf("third AU bytes = %v, want %v", third, wantThird)
	}
}

func TestH264RTPCodecCapabilityAdvertisesPacketizationMode(t *testing.T) {
	cap := h264RTPCodecCapability()
	if cap.MimeType != webrtc.MimeTypeH264 {
		t.Fatalf("MimeType = %q, want %q", cap.MimeType, webrtc.MimeTypeH264)
	}
	if cap.ClockRate != 90000 {
		t.Fatalf("ClockRate = %d, want 90000", cap.ClockRate)
	}
	if !strings.Contains(cap.SDPFmtpLine, "packetization-mode=1") {
		t.Fatalf("SDPFmtpLine = %q, want packetization-mode=1", cap.SDPFmtpLine)
	}
	if !strings.Contains(cap.SDPFmtpLine, "profile-level-id=42e01f") {
		t.Fatalf("SDPFmtpLine = %q, want constrained baseline profile", cap.SDPFmtpLine)
	}
}
