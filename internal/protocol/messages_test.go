package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestEnvelopeRoundTrip(t *testing.T) {
	in := Envelope{V: 1, Type: "rtc.description", RequestID: "r1", RoomID: "room", PeerID: "forged", Payload: json.RawMessage(`{"toPeerId":"peer-b","description":{"type":"offer","sdp":"x"},"tracks":[{"mid":"0","role":"screenVideo"}]}`)}
	b, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"requestId":"r1"`) || strings.Contains(string(b), "request_id") {
		t.Fatalf("wire names drifted: %s", b)
	}
	var got Envelope
	if err := Decode(b, &got); err != nil {
		t.Fatal(err)
	}
	if got.Type != in.Type || got.RequestID != in.RequestID || string(got.Payload) != string(in.Payload) {
		t.Fatalf("round trip mismatch: %#v", got)
	}
}

func TestPresentationMessagesRejectClientAssignedPresenter(t *testing.T) {
	for _, messageType := range []string{"share.claim", "share.release"} {
		var e Envelope
		if err := Decode([]byte(`{"v":1,"type":"`+messageType+`","requestId":"claim","payload":{}}`), &e); err != nil {
			t.Fatal(err)
		}
		if err := Decode([]byte(`{"v":1,"type":"`+messageType+`","requestId":"claim","payload":{"presenterPeerId":"forged"}}`), &e); err == nil {
			t.Fatal("client assigned presenter through payload")
		}
		e = Envelope{}
		if err := Decode([]byte(`{"v":1,"type":"`+messageType+`","payload":{}}`), &e); err == nil {
			t.Fatal("uncorrelated claim accepted")
		}
	}
}

func TestRejectUnknownRoleAndVersion(t *testing.T) {
	if err := ValidateRole(Role("admin")); err == nil {
		t.Fatal("unknown role accepted")
	}
	var e Envelope
	if err := Decode([]byte(`{"v":2,"type":"heartbeat","requestId":"1","payload":{}}`), &e); err == nil {
		t.Fatal("unsupported version accepted")
	}
}

func TestRejectOversizedAndMalformedSignal(t *testing.T) {
	var e Envelope
	if err := Decode([]byte(`{"v":1,"type":"rtc.candidate","requestId":"x","payload":{"candidate":"`+strings.Repeat("x", MaxMessageBytes)+`"}}`), &e); err == nil {
		t.Fatal("oversized message accepted")
	}
	if err := Decode([]byte(`{"v":1,"type":"rtc.description","requestId":"x","payload":{"description":{}}}`), &e); err == nil {
		t.Fatal("malformed SDP signal accepted")
	}
}

func TestTrackMapRequiresUniqueMID(t *testing.T) {
	if err := ValidateTracks([]Track{{MID: "0", Role: RoleScreenVideo}, {MID: "0", Role: RoleMicrophone}}); err == nil {
		t.Fatal("duplicate MID accepted")
	}
	if err := ValidateTracks([]Track{{MID: "0", Role: TrackRole("desktop")}}); err == nil {
		t.Fatal("unknown track role accepted")
	}
}

func TestScreenMessagesRequireOneAuthenticatedDirectionAndEpoch(t *testing.T) {
	for _, tc := range []struct{ kind, payload string }{
		{"screen.ready", `{"toPeerId":"viewer","epoch":"capture-1"}`},
		{"screen.ready", `{"fromPeerId":"presenter","epoch":"capture-1"}`},
		{"screen.description", `{"toPeerId":"presenter","epoch":"capture-1","description":{"type":"offer","sdp":"v=0"}}`},
		{"screen.description", `{"fromPeerId":"presenter","epoch":"capture-1","description":{"type":"answer","sdp":"v=0"}}`},
	} {
		wire, _ := json.Marshal(Envelope{V: 1, Type: tc.kind, RequestID: "screen-1", Payload: json.RawMessage(tc.payload)})
		if err := Decode(wire, new(Envelope)); err != nil {
			t.Fatalf("valid %s: %v", tc.kind, err)
		}
	}
	for _, tc := range []struct{ kind, payload string }{
		{"screen.ready", `{"toPeerId":"viewer"}`},
		{"screen.ready", `{"epoch":"capture-1"}`},
		{"screen.ready", `{"toPeerId":"viewer","fromPeerId":"forged","epoch":"capture-1"}`},
		{"screen.ready", `{"toPeerId":"viewer","epoch":"` + strings.Repeat("x", 65) + `"}`},
		{"screen.ready", `{"toPeerId":"viewer","epoch":"capture-1","sessionId":"local-secret"}`},
		{"screen.description", `{"toPeerId":"presenter","epoch":"capture-1","description":{"type":"rollback","sdp":"v=0"}}`},
		{"screen.description", `{"toPeerId":"presenter","epoch":"capture-1","description":{"type":"offer","sdp":""}}`},
	} {
		wire, _ := json.Marshal(Envelope{V: 1, Type: tc.kind, RequestID: "screen-1", Payload: json.RawMessage(tc.payload)})
		if err := Decode(wire, new(Envelope)); err == nil {
			t.Fatalf("invalid %s accepted: %s", tc.kind, tc.payload)
		}
	}
	if err := Decode([]byte(`{"v":1,"type":"screen.ready","payload":{"toPeerId":"viewer","epoch":"capture-1"}}`), new(Envelope)); err == nil {
		t.Fatal("uncorrelated screen negotiation accepted")
	}
}
