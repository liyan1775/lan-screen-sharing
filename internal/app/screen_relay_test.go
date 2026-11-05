package app

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestScreenRelayIsRestrictedToAuthenticatedSameOriginLocalControl(t *testing.T) {
	s := New(Config{})
	defer s.screens.Close()
	for _, tc := range []struct{ name, remote, origin, token, query string }{
		{"missing token", "127.0.0.1:1234", "http://localhost:8080", "", ""},
		{"LAN request", "192.168.1.5:1234", "http://localhost:8080", s.localControlToken, ""},
		{"foreign origin", "127.0.0.1:1234", "http://elsewhere:8080", s.localControlToken, ""},
		{"query token", "127.0.0.1:1234", "http://localhost:8080", s.localControlToken, "?token=secret"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "http://localhost:8080/api/v1/screen-relay"+tc.query, strings.NewReader(`{"action":"stop"}`))
			r.RemoteAddr = tc.remote
			r.Header.Set("Origin", tc.origin)
			r.Header.Set("X-Local-Control-Token", tc.token)
			w := httptest.NewRecorder()
			s.Handler().ServeHTTP(w, r)
			if w.Code != 403 {
				t.Fatalf("status %d", w.Code)
			}
		})
	}
	r := httptest.NewRequest("POST", "http://localhost:8080/api/v1/screen-relay", strings.NewReader(`{"action":"stop","sessionId":"stale"}`))
	r.RemoteAddr = "127.0.0.1:1234"
	r.Header.Set("Origin", "http://localhost:8080")
	r.Header.Set("X-Local-Control-Token", s.localControlToken)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("local stop: %d %s", w.Code, w.Body.String())
	}
}

func TestScreenRelayRejectsMalformedAndOversizedControlRequests(t *testing.T) {
	s := New(Config{})
	defer s.screens.Close()
	for _, body := range []string{
		`{"action":"stop","unknown":true}`,
		`{"action":"stop"} {"action":"start"}`,
		`{"action":"receiver","peerId":"../other"}`,
		`{"action":"unexpected"}`,
		`{"action":"start","description":{"type":"offer","sdp":"` + strings.Repeat("x", 256<<10) + `"}}`,
	} {
		r := httptest.NewRequest("POST", "http://localhost:8080/api/v1/screen-relay", strings.NewReader(body))
		r.RemoteAddr = "127.0.0.1:1234"
		r.Header.Set("Origin", "http://localhost:8080")
		r.Header.Set("X-Local-Control-Token", s.localControlToken)
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != 400 {
			t.Fatalf("invalid request status: %d", w.Code)
		}
	}
}
