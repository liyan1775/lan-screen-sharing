package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

const MaxMessageBytes = 256 << 10

type Envelope struct {
	V         int             `json:"v"`
	Type      string          `json:"type"`
	RequestID string          `json:"requestId,omitempty"`
	RoomID    string          `json:"roomId,omitempty"`
	PeerID    string          `json:"peerId,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

type Role string

const (
	RoleHost   Role = "host"
	RoleViewer Role = "viewer"
)

type TrackRole string

const (
	RoleScreenVideo TrackRole = "screenVideo"
	RoleSystemAudio TrackRole = "systemAudio"
	RoleMicrophone  TrackRole = "microphone"
)

type Track struct {
	MID  string    `json:"mid"`
	Role TrackRole `json:"role"`
}

type Description struct {
	Type string `json:"type"`
	SDP  string `json:"sdp"`
}

type Candidate struct {
	Candidate        string  `json:"candidate"`
	SDPMid           *string `json:"sdpMid,omitempty"`
	SDPMLineIndex    *uint16 `json:"sdpMLineIndex,omitempty"`
	UsernameFragment *string `json:"usernameFragment,omitempty"`
}

type SignalDescriptionPayload struct {
	ToPeerID    string      `json:"toPeerId"`
	Description Description `json:"description"`
	Tracks      []Track     `json:"tracks"`
}

type SignalCandidatePayload struct {
	ToPeerID  string    `json:"toPeerId"`
	Candidate Candidate `json:"candidate"`
}

type JoinPayload struct {
	HostIPv4     string `json:"hostIPv4"`
	HostPort     int    `json:"hostPort"`
	RoomCode     string `json:"roomCode"`
	ResumeToken  string `json:"resumeToken,omitempty"`
	RestartMedia bool   `json:"restartMedia,omitempty"`
}

type AuthHelloPayload struct {
	Role      Role   `json:"role"`
	HostToken string `json:"hostToken,omitempty"`
	RoomID    string `json:"roomId,omitempty"`
}

var knownTypes = map[string]bool{
	"auth.hello": true, "host.createRoom": true, "host.endRoom": true,
	"viewer.join": true, "viewer.leave": true, "rtc.description": true,
	"rtc.candidate": true, "media.state": true, "heartbeat": true,
	"signal.join": true, "signal.leave": true,
	"room.created": true, "room.joined": true, "room.state": true,
	"peer.joined": true, "peer.left": true, "peer.state": true,
	"room.ended": true, "error": true,
	"share.claim": true, "share.release": true,
}

func ValidateRole(role Role) error {
	if role != RoleHost && role != RoleViewer {
		return fmt.Errorf("unknown role %q", role)
	}
	return nil
}

func ValidateTracks(tracks []Track) error {
	seen := make(map[string]struct{}, len(tracks))
	for _, track := range tracks {
		if strings.TrimSpace(track.MID) == "" {
			return errors.New("track mid is required")
		}
		if _, ok := seen[track.MID]; ok {
			return fmt.Errorf("duplicate track mid %q", track.MID)
		}
		seen[track.MID] = struct{}{}
		switch track.Role {
		case RoleScreenVideo, RoleSystemAudio, RoleMicrophone:
		default:
			return fmt.Errorf("unknown track role %q", track.Role)
		}
	}
	return nil
}

func Decode(data []byte, target *Envelope) error {
	if len(data) > MaxMessageBytes {
		return errors.New("MESSAGE_TOO_LARGE")
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(target); err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		return errors.New("message must contain one JSON value")
	}
	if target.V != 1 {
		return errors.New("UNSUPPORTED_PROTOCOL")
	}
	if !knownTypes[target.Type] {
		return fmt.Errorf("unknown message type %q", target.Type)
	}
	if requiresRequestID(target.Type) && target.RequestID == "" {
		return errors.New("requestId is required")
	}
	if len(target.Payload) == 0 || string(target.Payload) == "null" {
		return errors.New("payload is required")
	}
	if !json.Valid(target.Payload) {
		return errors.New("payload must be valid JSON")
	}
	return validatePayload(*target)
}

func requiresRequestID(messageType string) bool {
	switch messageType {
	case "auth.hello", "host.createRoom", "host.endRoom", "viewer.join", "viewer.leave", "rtc.description", "rtc.candidate", "media.state", "heartbeat", "signal.join", "signal.leave", "share.claim", "share.release":
		return true
	default:
		return false
	}
}

func validatePayload(e Envelope) error {
	switch e.Type {
	case "auth.hello":
		var p AuthHelloPayload
		if err := decodePayload(e.Payload, &p); err != nil {
			return err
		}
		return ValidateRole(p.Role)
	case "rtc.description":
		var direction struct {
			FromPeerID string `json:"fromPeerId"`
		}
		_ = json.Unmarshal(e.Payload, &direction)
		if direction.FromPeerID != "" {
			var p struct {
				FromPeerID  string      `json:"fromPeerId"`
				Description Description `json:"description"`
				Tracks      []Track     `json:"tracks"`
			}
			if err := decodePayload(e.Payload, &p); err != nil {
				return err
			}
			if p.Description.SDP == "" {
				return errors.New("description SDP is required")
			}
			return ValidateTracks(p.Tracks)
		}
		var p SignalDescriptionPayload
		if err := decodePayload(e.Payload, &p); err != nil {
			return err
		}
		if p.ToPeerID == "" || p.Description.SDP == "" {
			return errors.New("description target and SDP are required")
		}
		switch p.Description.Type {
		case "offer", "answer", "pranswer", "rollback":
		default:
			return errors.New("invalid description type")
		}
		return ValidateTracks(p.Tracks)
	case "rtc.candidate":
		var direction struct {
			FromPeerID string `json:"fromPeerId"`
		}
		_ = json.Unmarshal(e.Payload, &direction)
		if direction.FromPeerID != "" {
			var p struct {
				FromPeerID string    `json:"fromPeerId"`
				Candidate  Candidate `json:"candidate"`
			}
			return decodePayload(e.Payload, &p)
		}
		var p SignalCandidatePayload
		if err := decodePayload(e.Payload, &p); err != nil {
			return err
		}
		if p.ToPeerID == "" {
			return errors.New("candidate target is required")
		}
	case "viewer.join":
		var p JoinPayload
		if err := decodePayload(e.Payload, &p); err != nil {
			return err
		}
		if p.HostIPv4 == "" || p.RoomCode == "" {
			return errors.New("join address and room code are required")
		}
	case "host.createRoom":
		var p struct {
			Name         string `json:"name,omitempty"`
			Discoverable *bool  `json:"discoverable,omitempty"`
		}
		return decodePayload(e.Payload, &p)
	case "host.endRoom", "viewer.leave", "signal.leave", "heartbeat", "share.claim", "share.release":
		var p struct{}
		return decodePayload(e.Payload, &p)
	case "signal.join":
		var p struct {
			RoomCode     string `json:"roomCode"`
			ResumeToken  string `json:"resumeToken,omitempty"`
			RestartMedia bool   `json:"restartMedia,omitempty"`
		}
		if err := decodePayload(e.Payload, &p); err != nil {
			return err
		}
		if p.RoomCode == "" {
			return errors.New("roomCode is required")
		}
	case "media.state":
		var p struct {
			ScreenSharing   bool   `json:"screenSharing"`
			HasScreenVideo  bool   `json:"hasScreenVideo"`
			HasSystemAudio  bool   `json:"hasSystemAudio"`
			IsolationStatus string `json:"isolationStatus"`
		}
		return decodePayload(e.Payload, &p)
	case "error":
		var p struct {
			Code      string `json:"code"`
			Message   string `json:"message"`
			Retryable bool   `json:"retryable"`
		}
		if err := decodePayload(e.Payload, &p); err != nil {
			return err
		}
		if p.Code == "" {
			return errors.New("error code is required")
		}
		if !knownErrorCodes[p.Code] {
			return fmt.Errorf("unknown error code %q", p.Code)
		}
	case "room.created":
		var p struct {
			Name         string `json:"name,omitempty"`
			Discoverable bool   `json:"discoverable,omitempty"`
			RoomID       string `json:"roomId"`
			HostPeerID   string `json:"hostPeerId"`
			RoomCode     string `json:"roomCode"`
			ExpiresAt    string `json:"expiresAt"`
		}
		return decodePayload(e.Payload, &p)
	case "room.joined":
		var p struct {
			Name                 string `json:"name,omitempty"`
			RoomID               string `json:"roomId"`
			PeerID               string `json:"peerId"`
			ResumeToken          string `json:"resumeToken"`
			PresenterPeerID      string `json:"presenterPeerId,omitempty"`
			PresentationRevision uint64 `json:"presentationRevision,omitempty"`
			ScreenSharing        bool   `json:"screenSharing,omitempty"`
			HasSystemAudio       bool   `json:"hasSystemAudio,omitempty"`
			IsolationStatus      string `json:"isolationStatus,omitempty"`
			Members              []struct {
				PeerID string `json:"peerId"`
				Role   string `json:"role"`
				State  string `json:"state"`
			} `json:"members"`
		}
		return decodePayload(e.Payload, &p)
	case "room.state":
		var p struct {
			Name     string `json:"name,omitempty"`
			RoomCode string `json:"roomCode,omitempty"`
			Resumed  bool   `json:"resumed,omitempty"`
			Members  []struct {
				PeerID string `json:"peerId"`
				Role   string `json:"role"`
				State  string `json:"state"`
			} `json:"members,omitempty"`
			ScreenSharing        *bool  `json:"screenSharing,omitempty"`
			PresentationRevision uint64 `json:"presentationRevision,omitempty"`
			PresenterPeerID      string `json:"presenterPeerId,omitempty"`
			HasSystemAudio       bool   `json:"hasSystemAudio,omitempty"`
			IsolationStatus      string `json:"isolationStatus,omitempty"`
		}
		return decodePayload(e.Payload, &p)
	case "peer.joined":
		var p struct {
			PeerID string `json:"peerId"`
			Role   string `json:"role"`
		}
		return decodePayload(e.Payload, &p)
	case "peer.left":
		var p struct {
			PeerID string `json:"peerId"`
			Reason string `json:"reason"`
		}
		return decodePayload(e.Payload, &p)
	case "peer.state":
		var p struct {
			PeerID       string `json:"peerId"`
			State        string `json:"state"`
			RestartMedia bool   `json:"restartMedia,omitempty"`
		}
		return decodePayload(e.Payload, &p)
	case "room.ended":
		var p struct {
			Reason string `json:"reason"`
		}
		return decodePayload(e.Payload, &p)
	}
	return nil
}

func decodePayload(data []byte, target any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	return dec.Decode(target)
}

func ErrorCode(err error) string {
	if err == nil {
		return ""
	}
	for code := range knownErrorCodes {
		if strings.Contains(err.Error(), code) {
			return code
		}
	}
	return "INVALID_MESSAGE"
}

var knownErrorCodes = map[string]bool{
	"INVALID_ROOM_NAME": true,
	"SHARE_BUSY":        true, "SHARE_NOT_OWNER": true,
	"AUTH_REQUIRED": true, "HOST_ONLY": true, "ROOM_NOT_FOUND": true, "ROOM_EXPIRED": true, "ROOM_FULL": true, "INVALID_INVITE": true, "INVALID_HOST_ADDRESS": true, "INVALID_PORT": true, "SIGNAL_TARGET_NOT_MEMBER": true, "MESSAGE_TOO_LARGE": true, "UNSUPPORTED_PROTOCOL": true, "ICE_FAILED": true, "MIC_PERMISSION_DENIED": true, "CAPTURE_CANCELLED": true, "DISPLAY_NOT_MONITOR": true, "SYSTEM_AUDIO_UNSUPPORTED": true, "SYSTEM_AUDIO_UNVERIFIED": true, "PORT_IN_USE": true, "SERVICE_START_FAILED": true,
	"INVALID_ROLE": true, "INVALID_MESSAGE": true, "ROOM_ALREADY_JOINED": true, "ROOM_EXISTS": true, "INVALID_SIGNAL_PATH": true, "RATE_LIMITED": true, "SIGNAL_CONNECTION_LOST": true,
}
