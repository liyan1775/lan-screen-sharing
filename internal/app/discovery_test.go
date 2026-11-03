package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRoomDiscoveryEndpointRequiresLocalOriginAndControlNonce(t *testing.T) {
	s := New(Config{LANIPv4: "192.168.1.10"})
	defer s.rooms.EndAll()
	for _, condition := range []struct {
		remote, origin, token string
		status                int
	}{{"127.0.0.1:5000", "http://localhost:8000", s.localControlToken, 200}, {"127.0.0.1:5000", "http://localhost:8000", "", 403}, {"192.168.1.50:5000", "http://localhost:8000", s.localControlToken, 403}, {"127.0.0.1:5000", "https://elsewhere.invalid", s.localControlToken, 403}} {
		r := httptest.NewRequest(http.MethodGet, "http://localhost:8000/api/v1/rooms", nil)
		r.RemoteAddr = condition.remote
		r.Header.Set("Origin", condition.origin)
		r.Header.Set("X-Local-Control-Token", condition.token)
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != condition.status {
			t.Fatalf("discovery status %d, expected %d", w.Code, condition.status)
		}
	}
	r := httptest.NewRequest(http.MethodGet, "http://localhost:8000/api/v1/rooms", nil)
	r.RemoteAddr = "127.0.0.1:5000"
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	r.Header.Set("Referer", "http://localhost:8000/")
	r.Header.Set("X-Local-Control-Token", s.localControlToken)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("browser GET without Origin was rejected: %d", w.Code)
	}
}
func TestRoomDiscoveryListsOnlyAdvertisedRoomsWithoutControlCredentials(t *testing.T) {
	s := New(Config{LANIPv4: "192.168.1.10"})
	defer s.rooms.EndAll()
	public, _, err := s.rooms.CreateHostWithOptions("朋友一起玩", true)
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = s.rooms.CreateHostWithOptions("不要公开", false)
	if err != nil {
		t.Fatal(err)
	}
	s.lanActive = true
	s.lanPort = 45678 // No socket or service is created by this test.
	r := httptest.NewRequest(http.MethodGet, "http://localhost:8000/api/v1/rooms", nil)
	r.RemoteAddr = "127.0.0.1:5000"
	r.Header.Set("Origin", "http://localhost:8000")
	r.Header.Set("X-Local-Control-Token", s.localControlToken)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("status %d", w.Code)
	}
	var body struct {
		Rooms []struct {
			Name, RoomCode string
			Own            bool
		}
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Rooms) != 1 || body.Rooms[0].Name != public.Name || body.Rooms[0].RoomCode != public.Code || !body.Rooms[0].Own {
		t.Fatal("private or missing room in discovery")
	}
	if strings.Contains(w.Body.String(), s.hostToken) || strings.Contains(w.Body.String(), s.localControlToken) {
		t.Fatal("control credential leaked into room list")
	}
}

func TestRoomDiscoveryStartupFailureIsReportedWithoutRawErrorDetails(t *testing.T) {
	s := New(Config{LANIPv4: "192.168.1.10"})
	defer s.rooms.EndAll()
	s.discoveryError = "NETWORK_PERMISSION_DENIED"
	r := httptest.NewRequest(http.MethodGet, "http://localhost:8000/api/v1/rooms", nil)
	r.RemoteAddr = "127.0.0.1:5000"
	r.Header.Set("Origin", "http://localhost:8000")
	r.Header.Set("X-Local-Control-Token", s.localControlToken)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	var body struct {
		Available   bool
		Message     string
		Diagnostics struct{ LastError string }
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Available || body.Diagnostics.LastError != "NETWORK_PERMISSION_DENIED" || !strings.Contains(body.Message, "网络通信权限") {
		t.Fatal("startup failure was indistinguishable from an empty healthy list")
	}
}
