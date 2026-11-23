package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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
		defaults.ShareMode != "combined" || !defaults.PauseBackgroundPreview || !defaults.SoundEffects || defaults.ShareCursor {
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
	if loaded != s.preferences.snapshot() || loaded.Nickname != "星河🌙" || loaded.AvatarColor != "pink" ||
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
	if got := New(Config{}).preferences.snapshot(); got != loaded {
		t.Fatalf("patch clobbered the other preferences: %+v", got)
	}
	file, err := os.ReadFile(path)
	var keys map[string]json.RawMessage
	if err != nil || json.Unmarshal(file, &keys) != nil || len(keys) != 11 {
		t.Fatalf("preference file does not contain exactly the eleven permitted fields: %s (%v)", file, err)
	}
	if files, err := os.ReadDir(filepath.Dir(path)); err != nil || len(files) != 1 {
		t.Fatalf("temporary preference files were not cleaned up: %v %v", files, err)
	}
	if isolated := New(Config{PreferencesPath: filepath.Join(t.TempDir(), "other.json")}); isolated.preferences.snapshot() != defaults {
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
		`{"resumeToken":"secret"}`, `{"roomCode":"secret"}`, `{"localControlToken":"secret"}`, `{} {}`,
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
