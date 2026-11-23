package protocol

import (
	"strings"
	"unicode"
)

const MaxNicknameRunes = 20

type Profile struct {
	Nickname    string `json:"nickname"`
	AvatarColor string `json:"avatarColor"`
}

type ProfileUpdate struct {
	Profile
	ProfileRevision uint64 `json:"profileRevision,omitempty"`
}

type Member struct {
	PeerID    string `json:"peerId"`
	Role      string `json:"role"`
	State     string `json:"state"`
	SeatIndex int    `json:"seatIndex"`
	ProfileUpdate
}

func ValidAvatarColor(color string) bool {
	switch color {
	case "blue", "indigo", "teal", "green", "orange", "pink":
		return true
	}
	return false
}

func (p Profile) Normalized() Profile {
	name := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, p.Nickname)
	name = strings.TrimSpace(name)
	count := 0
	for offset := range name {
		if count == MaxNicknameRunes {
			name = strings.TrimSpace(name[:offset])
			break
		}
		count++
	}
	p.Nickname = name
	if !ValidAvatarColor(p.AvatarColor) {
		p.AvatarColor = "blue"
	}
	return p
}
