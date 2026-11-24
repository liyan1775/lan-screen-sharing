package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"lan-screen-sharing/internal/discovery"
	"lan-screen-sharing/internal/protocol"
)

const PreferencesPathEnv = "LANSW_PREFERENCES_PATH"
const maxPreferencesBytes = 8192

type Preferences struct {
	protocol.Profile
	PeerHosts              []string `json:"peerHosts"`
	PreferredLANIPv4       string   `json:"preferredLanIPv4"`
	QualityTarget          string   `json:"qualityTarget"`
	ShareMode              string   `json:"shareMode"`
	PauseBackgroundPreview bool     `json:"pauseBackgroundPreview"`
	ShareCursor            bool     `json:"shareCursor"`
	MicMode                string   `json:"micMode"`
	MicDeviceID            string   `json:"micDeviceId"`
	MicDeviceLabel         string   `json:"micDeviceLabel"`
	SoundEffects           bool     `json:"soundEffects"`
}

type preferenceStore struct {
	mu   sync.Mutex
	path string
	data Preferences
}

func openPreferences(path string) *preferenceStore {
	if path == "" {
		path = os.Getenv(PreferencesPathEnv)
	}
	if path == "" {
		if dir, err := os.UserConfigDir(); err == nil {
			path = filepath.Join(dir, "lan-screen-sharing", "preferences.json")
		}
	}
	store := &preferenceStore{path: path, data: Preferences{
		Profile: protocol.Profile{AvatarColor: "blue"}, QualityTarget: "1080p60", PeerHosts: []string{},
		ShareMode: "combined", PauseBackgroundPreview: true, MicMode: "open", SoundEffects: true,
	}}
	if file, err := os.Open(path); err == nil {
		defer file.Close()
		if data, err := io.ReadAll(io.LimitReader(file, maxPreferencesBytes+1)); err == nil && len(data) <= maxPreferencesBytes {
			if restored, err := decodePreferences(bytes.NewReader(data), store.data); err == nil {
				store.data = restored
			}
		}
	}
	return store
}

func (s *preferenceStore) snapshot() Preferences {
	s.mu.Lock()
	defer s.mu.Unlock()
	values := s.data
	values.PeerHosts = slices.Clone(values.PeerHosts)
	return values
}

func (s *preferenceStore) update(patch func(Preferences) (Preferences, error)) (Preferences, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	next, err := patch(s.data)
	if err != nil {
		return s.data, err
	}
	if err = writePreferences(s.path, next); err != nil {
		return s.data, err
	}
	s.data = next
	return next, nil
}

func writePreferences(path string, values Preferences) error {
	if path == "" {
		return errors.New("preferences directory unavailable")
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(dir, ".preferences-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err = json.NewEncoder(file).Encode(values); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(file.Name(), path)
}

var errInvalidPreferences = errors.New("invalid preferences")

func decodePreferences(input io.Reader, next Preferences) (Preferences, error) {
	decoder := json.NewDecoder(input)
	start, err := decoder.Token()
	if err != nil || start != json.Delim('{') {
		return Preferences{}, errInvalidPreferences
	}
	var peerHosts []string
	fields := map[string]any{
		"nickname": &next.Nickname, "avatarColor": &next.AvatarColor,
		"preferredLanIPv4": &next.PreferredLANIPv4, "peerHosts": &peerHosts, "qualityTarget": &next.QualityTarget,
		"shareMode": &next.ShareMode, "pauseBackgroundPreview": &next.PauseBackgroundPreview,
		"shareCursor": &next.ShareCursor, "micMode": &next.MicMode,
		"micDeviceId": &next.MicDeviceID, "micDeviceLabel": &next.MicDeviceLabel, "soundEffects": &next.SoundEffects,
	}
	for decoder.More() {
		token, err := decoder.Token()
		key, ok := token.(string)
		field := fields[key]
		if err != nil || !ok || field == nil {
			return Preferences{}, errInvalidPreferences
		}
		delete(fields, key)
		var raw json.RawMessage
		if decoder.Decode(&raw) != nil || bytes.Equal(raw, []byte("null")) || !utf8.Valid(raw) || json.Unmarshal(raw, field) != nil {
			return Preferences{}, fmt.Errorf("%w: %s", errInvalidPreferences, key)
		}
	}
	end, err := decoder.Token()
	var extra any
	if err != nil || end != json.Delim('}') || decoder.Decode(&extra) != io.EOF {
		return Preferences{}, errInvalidPreferences
	}
	name := strings.TrimSpace(next.Nickname)
	if name != (protocol.Profile{Nickname: name}).Normalized().Nickname ||
		!protocol.ValidAvatarColor(next.AvatarColor) ||
		(next.PreferredLANIPv4 != "" && !validPrivateIPv4(next.PreferredLANIPv4)) ||
		(next.QualityTarget != "1080p60" && next.QualityTarget != "720p60" && next.QualityTarget != "720p30") ||
		(next.ShareMode != "combined" && next.ShareMode != "limited") ||
		(next.MicMode != "open" && next.MicMode != "ptt") ||
		len(next.MicDeviceID) > 256 || strings.ContainsFunc(next.MicDeviceID, unicode.IsControl) ||
		len(next.MicDeviceLabel) > 640 || strings.ContainsFunc(next.MicDeviceLabel, unicode.IsControl) {
		return Preferences{}, errInvalidPreferences
	}
	if _, omitted := fields["peerHosts"]; !omitted {
		next.PeerHosts = peerHosts
	}
	peers := make([]string, 0, discovery.MaxDirectPeers)
	for _, ip := range next.PeerHosts {
		if !validPrivateIPv4(ip) {
			return Preferences{}, fmt.Errorf("%w: peerHosts", errInvalidPreferences)
		}
		if !slices.Contains(peers, ip) {
			if len(peers) == discovery.MaxDirectPeers {
				return Preferences{}, fmt.Errorf("%w: peerHosts", errInvalidPreferences)
			}
			peers = append(peers, ip)
		}
	}
	next.PeerHosts = peers
	next.Nickname = name
	return next, nil
}

func (s *Server) servePreferences(w http.ResponseWriter, r *http.Request) {
	if !s.validControlPOST(r) {
		writeError(w, http.StatusForbidden, "AUTH_REQUIRED", "偏好设置仅供本机程序页面使用", false)
		return
	}
	body := http.MaxBytesReader(w, r.Body, maxPreferencesBytes)
	defer body.Close()
	raw, err := io.ReadAll(body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_PREFERENCES", "设置内容无效，请检查昵称长度和选项", false)
		return
	}
	s.lanMu.Lock()
	var peersChanged bool
	values, err := s.preferences.update(func(current Preferences) (Preferences, error) {
		next, err := decodePreferences(bytes.NewReader(raw), current)
		peersChanged = !slices.Equal(current.PeerHosts, next.PeerHosts)
		return next, err
	})
	if err == nil && peersChanged {
		s.applyDiscoveryPeersLocked(values.PeerHosts)
	}
	s.lanMu.Unlock()
	switch {
	case errors.Is(err, errInvalidPreferences):
		writeError(w, http.StatusBadRequest, "INVALID_PREFERENCES", "设置内容无效，请检查昵称长度和选项", false)
	case err != nil:
		writeError(w, http.StatusInternalServerError, "PREFERENCES_WRITE_FAILED", "无法保存本机设置，请检查配置目录的写入权限", true)
	default:
		writeJSON(w, map[string]any{"preferences": values})
	}
}

func (s *Server) validControlPOST(r *http.Request) bool {
	return r.Method == http.MethodPost && r.URL.RawQuery == "" &&
		validLocalBrowserRequest(r) && s.authorizeLocalControl(r, r.Header.Get("X-Local-Control-Token"))
}

func writeJSON(w http.ResponseWriter, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(data)
}
