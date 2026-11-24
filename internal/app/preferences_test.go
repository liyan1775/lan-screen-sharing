package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func localControlRequest(s *Server, route, body string) *http.Request {
	const origin = "http://127.0.0.1:8123"
	r := httptest.NewRequest(http.MethodPost, origin+route, strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:1234"
	r.Header.Set("Origin", origin)
	r.Header.Set("X-Local-Control-Token", s.localControlToken)
	return r
}

func TestPreferencesPersistAcrossServerInstances(t *testing.T) {
	path := filepath.Join(t.TempDir(), "profile", "preferences.json")
	t.Setenv(PreferencesPathEnv, path)
	s := New(Config{})
	defaults := s.preferences.snapshot()
	if defaults.AvatarColor != "blue" || defaults.MicMode != "open" || defaults.QualityTarget != "1080p60" ||
		defaults.PeerHosts == nil || len(defaults.PeerHosts) != 0 || defaults.ShareMode != "combined" || !defaults.PauseBackgroundPreview || !defaults.SoundEffects || defaults.ShareCursor {
		t.Fatalf("unexpected defaults: %+v", defaults)
	}
	const body = `{"nickname":"  星河🌙  ","avatarColor":"pink","preferredLanIPv4":"172.22.9.44","qualityTarget":"720p60","shareMode":"limited","pauseBackgroundPreview":false,"shareCursor":true,"micMode":"ptt","micDeviceId":"local-mic","micDeviceLabel":"桌面麦克风","soundEffects":false}`
	request := localControlRequest(s, "/api/v1/preferences", body)
	result := httptest.NewRecorder()
	s.Handler().ServeHTTP(result, request)
	if result.Code != http.StatusOK {
		t.Fatalf("saving preferences: %d %s", result.Code, result.Body)
	}
	next := New(Config{})
	loaded := next.preferences.snapshot()
	if !reflect.DeepEqual(loaded, s.preferences.snapshot()) || loaded.Nickname != "星河🌙" || loaded.AvatarColor != "pink" ||
		loaded.PauseBackgroundPreview || !loaded.ShareCursor || loaded.SoundEffects || loaded.MicDeviceID != "local-mic" || loaded.MicDeviceLabel != "桌面麦克风" ||
		loaded.PreferredLANIPv4 != "172.22.9.44" || loaded.ShareMode != "limited" || loaded.QualityTarget != "720p60" || loaded.MicMode != "ptt" {
		t.Fatalf("preferences did not round-trip: %+v", loaded)
	}

	result = httptest.NewRecorder()
	next.Handler().ServeHTTP(result, localControlRequest(next, "/api/v1/preferences", `{"qualityTarget":"720p30"}`))
	if result.Code != http.StatusOK {
		t.Fatalf("patching existing preferences: %d %s", result.Code, result.Body)
	}
	loaded.QualityTarget = "720p30"
	if got := New(Config{}).preferences.snapshot(); !reflect.DeepEqual(got, loaded) {
		t.Fatalf("patch clobbered the other preferences: %+v", got)
	}
	file, err := os.ReadFile(path)
	var keys map[string]json.RawMessage
	if err != nil || json.Unmarshal(file, &keys) != nil || len(keys) != 12 || string(keys["peerHosts"]) != "[]" {
		t.Fatalf("preference file does not contain the expected twelve fields: %s (%v)", file, err)
	}
	if files, err := os.ReadDir(filepath.Dir(path)); err != nil || len(files) != 1 {
		t.Fatalf("temporary preference files were not cleaned up: %v %v", files, err)
	}
	if isolated := New(Config{PreferencesPath: filepath.Join(t.TempDir(), "other.json")}); !reflect.DeepEqual(isolated.preferences.snapshot(), defaults) {
		t.Fatal("Config path must take priority over environment path")
	}
}

func TestPreferencesRejectInvalidPatchesAndRemoteRequests(t *testing.T) {
	file := filepath.Join(t.TempDir(), "preferences.json")
	s := New(Config{PreferencesPath: file})
	for _, raw := range []string{
		`null`, `[]`, `{"nickname":null}`, `{"nickname":"a","nickname":"b"}`, `{"Nickname":"case"}`,
		`{"nickname":"` + strings.Repeat("🌙", 21) + `"}`, `{"nickname":"x\u0000y"}`,
		`{"avatarColor":"#ffffff"}`, `{"preferredLanIPv4":"127.0.0.1"}`, `{"preferredLanIPv4":"100.64.0.1"}`,
		`{"qualityTarget":"4k"}`, `{"shareMode":"screen"}`, `{"shareCursor":"true"}`, `{"micMode":"other"}`,
		`{"micDeviceId":"` + strings.Repeat("a", 257) + `"}`, `{"soundEffects":null}`,
		`{"micDeviceLabel":"` + strings.Repeat("a", 641) + `"}`, `{"micDeviceLabel":"x\u0000y"}`,
		`{"resumeToken":"secret"}`, `{"roomCode":"secret"}`, `{"peerHosts":null}`, `{"peerHosts":"10.1.1.1"}`, `{"peerHosts":[1]}`,
		`{"peerHosts":["127.0.0.1"]}`, `{"peerHosts":["::ffff:10.1.1.1"]}`, `{"peerHosts":["fd00::1"]}`,
		`{"peerHosts":["8.8.8.8"]}`, `{"peerHosts":["100.64.0.1"]}`, `{"peerHosts":["10.208.138.52:49877"]}`,
		`{"peerHosts":[" 10.208.138.52"]}`, `{"peerHosts":["10.001.1.1"]}`, `{"peerHosts":["172.32.0.1"]}`,
		`{"peerHosts":["10.0.0.1","10.0.0.2","10.0.0.3","10.0.0.4","10.0.0.5","10.0.0.6","10.0.0.7","10.0.0.8","10.0.0.9"]}`, `{"localControlToken":"secret"}`, `{} {}`,
	} {
		result := httptest.NewRecorder()
		s.Handler().ServeHTTP(result, localControlRequest(s, "/api/v1/preferences", raw))
		if result.Code != http.StatusBadRequest {
			t.Errorf("%s returned %d, want 400: %s", raw, result.Code, result.Body)
		}
	}
	for _, change := range []func(*http.Request){
		func(r *http.Request) { r.Header.Del("Origin") },
		func(r *http.Request) { r.Header.Set("Origin", "http://127.0.0.1:8124") },
		func(r *http.Request) { r.Header.Set("Origin", "http://127.0.0.1:8123/other") },
		func(r *http.Request) { r.Header.Set("X-Local-Control-Token", "wrong") },
		func(r *http.Request) { r.RemoteAddr = "192.168.1.11:1234" },
	} {
		for _, path := range []string{"/api/v1/preferences", "/api/v1/network"} {
			request := localControlRequest(s, path, `{}`)
			change(request)
			result := httptest.NewRecorder()
			s.Handler().ServeHTTP(result, request)
			if result.Code != http.StatusForbidden {
				t.Fatalf("unauthorized %s returned %d", path, result.Code)
			}
		}
	}
	for _, path := range []string{"/api/v1/preferences", "/api/v1/network", "/api/v1/bootstrap"} {
		result := httptest.NewRecorder()
		s.LANHandler().ServeHTTP(result, localControlRequest(s, path, `{}`))
		if result.Code != http.StatusNotFound {
			t.Fatalf("LAN listener exposed %s: %d", path, result.Code)
		}
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) || s.preferences.snapshot().Nickname != "" {
		t.Fatal("an invalid write changed preferences")
	}
}

func TestPeerPreferencesLoadLegacyAndApplyPersistedChanges(t *testing.T) {
	file := filepath.Join(t.TempDir(), "preferences.json")
	if err := os.WriteFile(file, []byte(`{"nickname":"旧昵称"}`), 0600); err != nil {
		t.Fatal(err)
	}
	s := New(Config{PreferencesPath: file})
	initial := s.preferences.snapshot()
	if initial.Nickname != "旧昵称" || initial.PeerHosts == nil || len(initial.PeerHosts) != 0 {
		t.Fatalf("legacy preferences did not load with an empty peer list: %+v", initial)
	}
	service := &testDiscoveryGeneration{}
	s.discoveryService = service
	save := func(body string) int {
		result := httptest.NewRecorder()
		s.Handler().ServeHTTP(result, localControlRequest(s, "/api/v1/preferences", body))
		return result.Code
	}
	want := []string{"10.208.141.20", "172.22.1.5"}
	if status := save(`{"peerHosts":["10.208.141.20","10.208.141.20","172.22.1.5"]}`); status != http.StatusOK {
		t.Fatalf("save initial peers: %d", status)
	}
	if service.refreshes != 1 || !slices.Equal(service.peers, want) || !slices.Equal(openPreferences(file).snapshot().PeerHosts, want) {
		t.Fatal("deduplicated peers were not persisted and applied to the running discovery service")
	}
	for _, body := range []string{`{"peerHosts":["192.168.1.5",null]}`, `{"peerHosts":["10.1.2.3"],"nickname":null}`} {
		if status := save(body); status != http.StatusBadRequest || !slices.Equal(s.preferences.snapshot().PeerHosts, want) || !slices.Equal(service.peers, want) {
			t.Fatalf("invalid patch altered existing peers: %d %s", status, body)
		}
	}
	if status := save(`{"qualityTarget":"720p30"}`); status != http.StatusOK || service.refreshes != 1 || !slices.Equal(s.preferences.snapshot().PeerHosts, want) {
		t.Fatalf("unrelated patch altered configured peers: %d", status)
	}
	if status := save(`{"peerHosts":[]}`); status != http.StatusOK || service.refreshes != 2 || service.peers == nil || len(service.peers) != 0 {
		t.Fatalf("clearing peers did not update the live service: %d", status)
	}
	if peers := openPreferences(file).snapshot().PeerHosts; peers == nil || len(peers) != 0 {
		t.Fatalf("cleared peers did not persist as an empty list: %v", peers)
	}
}
