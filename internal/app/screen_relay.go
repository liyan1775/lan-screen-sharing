package app

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/pion/webrtc/v4"
)

func (s *Server) serveScreenRelay(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.URL.RawQuery != "" || !validLocalBrowserRequest(r) || !s.authorizeLocalControl(r, r.Header.Get("X-Local-Control-Token")) {
		writeError(w, http.StatusForbidden, "AUTH_REQUIRED", "媒体控制仅限已验证的本机页面", false)
		return
	}
	var request struct {
		Action      string                    `json:"action"`
		SessionID   string                    `json:"sessionId"`
		PeerID      string                    `json:"peerId"`
		Description webrtc.SessionDescription `json:"description"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10))
	decoder.DisallowUnknownFields()
	var extra any
	if decoder.Decode(&request) != nil || decoder.Decode(&extra) != io.EOF {
		writeError(w, 400, "INVALID_MESSAGE", "媒体请求无效", false)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	var answer webrtc.SessionDescription
	var err error
	id := request.SessionID
	switch request.Action {
	case "start":
		id, answer, err = s.screens.Start(ctx, request.Description)
	case "receiver":
		if !relayPeerID(request.PeerID) {
			writeError(w, 400, "INVALID_MESSAGE", "成员标识无效", false)
			return
		}
		answer, err = s.screens.Answer(ctx, id, request.PeerID, request.Description)
	case "remove":
		s.screens.RemoveReceiver(id, request.PeerID)
	case "stop":
		s.screens.Stop(id)
	default:
		writeError(w, 400, "INVALID_MESSAGE", "媒体操作无效", false)
		return
	}
	if err != nil {
		writeError(w, 409, "SCREEN_RELAY_UNAVAILABLE", "本机媒体连接未能建立，请停止共享后重试", true)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]any{"sessionId": id, "description": answer})
}

func relayPeerID(value string) bool {
	if len(value) < 1 || len(value) > 128 {
		return false
	}
	for _, c := range value {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}
