package app

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"

	"lan-screen-sharing/internal/discovery"
)

func (s *Server) roomAdvertisements() []discovery.Advertisement {
	s.lanMu.RLock()
	active, port := s.lanActive, s.lanPort
	s.lanMu.RUnlock()
	result := []discovery.Advertisement{}
	if !active || port == 0 {
		return result
	}
	for _, snapshot := range s.rooms.DiscoverableRooms() {
		result = append(result, discovery.Advertisement{RoomID: snapshot.ID, Name: snapshot.Name, RoomCode: snapshot.Code, Port: port, Members: len(snapshot.Members), ScreenSharing: snapshot.ScreenSharing})
	}
	return result
}
func (s *Server) startRoomDiscovery(ctx context.Context) {
	service, err := discovery.Start(ctx, s.config.LANIPv4, s.roomAdvertisements)
	s.discoveryMu.Lock()
	defer s.discoveryMu.Unlock()
	if err != nil {
		s.discoveryError = discovery.ErrorCode(err)
		return
	}
	if s.discoveryStopping || s.discoveryService != nil {
		service.Close()
		return
	}
	s.discoveryService = service
	s.discoveryError = ""
}

func (s *Server) serveDiscoveredRooms(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet || r.URL.RawQuery != "" || !validLocalBootstrapRequest(r) || !s.authorizeLocalControl(r, r.Header.Get("X-Local-Control-Token")) {
		writeError(w, http.StatusForbidden, "AUTH_REQUIRED", "房间列表仅供本机程序页面使用", false)
		return
	}
	s.discoveryMu.Lock()
	service := s.discoveryService
	startupError := s.discoveryError
	s.discoveryMu.Unlock()
	rooms := []discovery.Room{}
	diagnostics := discovery.Diagnostics{LocalIPv4: s.config.LANIPv4, LastError: startupError}
	if service != nil {
		rooms = service.Rooms()
		diagnostics = service.Diagnostics()
	}
	own := map[string]discovery.Advertisement{}
	for _, a := range s.roomAdvertisements() {
		key := s.config.LANIPv4 + ":" + strconv.Itoa(a.Port) + "/" + a.RoomID
		own[key] = a
	}
	for i := range rooms {
		if _, ok := own[rooms[i].ID]; ok {
			rooms[i].Own = true
			delete(own, rooms[i].ID)
		}
	}
	for key, a := range own {
		rooms = append(rooms, discovery.Room{ID: key, RoomID: a.RoomID, Name: a.Name, HostIPv4: s.config.LANIPv4, HostPort: a.Port, RoomCode: a.RoomCode, Members: a.Members, Capacity: 3, ScreenSharing: a.ScreenSharing, Own: true})
	}
	message := "正在通过局域网广播和组播查找房间；朋友创建房间后会显示在这里。"
	if !diagnostics.Running {
		message = "房间查找暂不可用，可查看下方诊断，或使用“手动加入”。"
		switch diagnostics.LastError {
		case "NO_PRIVATE_NETWORK", "NETWORK_INTERFACE_UNAVAILABLE":
			message = "未找到可用的局域网连接，请确认电脑已连接 Wi-Fi 或网线后重新打开程序。"
		case "NETWORK_PERMISSION_DENIED":
			message = "系统拒绝了局域网查找，请检查本程序的网络通信权限，也可以手动加入。"
		case "DISCOVERY_PORT_IN_USE":
			message = "房间查找端口被其他程序占用；可以先使用手动加入。"
		case "":
			message = "正在启动房间查找，请稍候…"
		}
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]any{"available": diagnostics.Running, "rooms": rooms, "message": message, "diagnostics": diagnostics})
}
