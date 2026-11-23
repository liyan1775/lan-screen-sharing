package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"slices"
	"strings"
	"time"
	"unicode"

	"lan-screen-sharing/internal/discovery"
	"lan-screen-sharing/internal/screenrelay"
	"lan-screen-sharing/internal/signal"
)

type LANInterface struct {
	Name        string `json:"name"`
	IPv4        string `json:"ipv4"`
	Virtual     bool   `json:"virtual"`
	Recommended bool   `json:"recommended"`
	Active      bool   `json:"active"`
}

type lanState struct {
	LANIPv4         string         `json:"lanIPv4"`
	SignalPort      int            `json:"signalPort"`
	LANInterfaces   []LANInterface `json:"lanInterfaces"`
	LANAutoSelected bool           `json:"lanAutoSelected"`
}

func validPrivateIPv4(value string) bool {
	ip, err := netip.ParseAddr(value)
	return err == nil && ip.Is4() && ip.IsPrivate()
}

func virtualInterface(name string, flags net.Flags) bool {
	if flags&net.FlagPointToPoint != 0 {
		return true
	}
	name = strings.ToLower(name)
	for _, marker := range []string{"wsl", "hyper-v", "hyperv", "vethernet", "virtualbox", "vmware", "docker",
		"tailscale", "clash", "wireguard", "zerotier", "loopback", "openvpn", "wintun", "tap-windows",
		"virtual", "虚拟", "npcap", "hamachi"} {
		if strings.Contains(name, marker) {
			return true
		}
	}
	for _, word := range strings.FieldsFunc(name, func(r rune) bool { return !unicode.IsLetter(r) }) {
		switch word {
		case "meta", "tun", "tap", "vpn", "tunnel", "utun", "wg", "ppp":
			return true
		}
	}
	return false
}

func interfacePriority(face LANInterface) int {
	if face.Virtual {
		return 2
	}
	name := strings.ToLower(face.Name)
	for _, marker := range []string{"wi-fi", "wifi", "wlan", "wireless", "无线", "ethernet", "以太网"} {
		if strings.Contains(name, marker) {
			return 0
		}
	}
	return 1
}

func rankLANInterfaces(faces []LANInterface) []LANInterface {
	faces = append([]LANInterface{}, faces...)
	slices.SortFunc(faces, func(a, b LANInterface) int {
		if order := interfacePriority(a) - interfacePriority(b); order != 0 {
			return order
		}
		if order := strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)); order != 0 {
			return order
		}
		return strings.Compare(a.IPv4, b.IPv4)
	})
	seen := map[string]bool{}
	ranked := make([]LANInterface, 0, len(faces))
	for _, face := range faces {
		if seen[face.IPv4] {
			continue
		}
		seen[face.IPv4] = true
		face.Recommended = len(ranked) == 0
		ranked = append(ranked, face)
	}
	return ranked
}

func enumerateLANInterfaces() []LANInterface {
	interfaces, _ := net.Interfaces()
	var faces []LANInterface
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 {
			continue
		}
		addresses, _ := iface.Addrs()
		for _, address := range addresses {
			ipText, _, _ := strings.Cut(address.String(), "/")
			if validPrivateIPv4(ipText) {
				faces = append(faces, LANInterface{Name: iface.Name, IPv4: ipText,
					Virtual: iface.Flags&net.FlagLoopback != 0 || virtualInterface(iface.Name, iface.Flags)})
			}
		}
	}
	return faces
}

func selectLANIPv4(explicit, preferred string, faces []LANInterface) string {
	if explicit != "" {
		return explicit
	}
	for _, face := range faces {
		if face.IPv4 == preferred {
			return preferred
		}
	}
	if len(faces) > 0 {
		return faces[0].IPv4
	}
	return ""
}

func firstPrivateIPv4() string {
	return selectLANIPv4("", "", rankLANInterfaces(enumerateLANInterfaces()))
}

func FirstPrivateIPv4() string { return firstPrivateIPv4() }

type lanDiscovery interface {
	Close()
	Rooms() []discovery.Room
	Diagnostics() discovery.Diagnostics
}

func (s *Server) networkStateLocked() lanState {
	faces := rankLANInterfaces(s.listLANInterfaces())
	for i := range faces {
		faces[i].Active = faces[i].IPv4 == s.lanIP
	}
	return lanState{LANIPv4: s.lanIP, SignalPort: s.lanPort, LANInterfaces: faces, LANAutoSelected: s.lanAutoSelected}
}

func (s *Server) StartLAN(ctx context.Context) (net.Listener, error) {
	s.lanMu.Lock()
	defer s.lanMu.Unlock()
	return s.startLANLocked(ctx, s.config.SignalPort)
}

func (s *Server) startLANLocked(parent context.Context, port int) (net.Listener, error) {
	select {
	case <-parent.Done():
		return nil, errors.New("SERVICE_STOPPING")
	case <-s.shutdownRequested:
		return nil, errors.New("SERVICE_STOPPING")
	default:
	}
	if s.lanListener != nil {
		return s.lanListener, nil
	}
	if !validPrivateIPv4(s.lanIP) {
		return nil, errors.New("INVALID_HOST_ADDRESS")
	}
	ln, err := s.listenLAN(s.lanIP, port)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.WithoutCancel(parent))
	server := &http.Server{
		Handler: s.lanHandlerFor(s.lanIP), ReadHeaderTimeout: 5 * time.Second,
		BaseContext: func(net.Listener) context.Context { return ctx },
	}
	s.lanListener, s.lanServer, s.cancelLAN = ln, server, cancel
	s.lanPort, s.lanActive = ln.Addr().(*net.TCPAddr).Port, true
	go func() { _ = server.Serve(ln) }()
	go func() {
		<-ctx.Done()
		_ = server.Close()
	}()
	return ln, nil
}

func (s *Server) stopLANLocked(ctx context.Context) {
	if s.lanServer != nil {
		// Shutdown drains HTTP. Cancel the generation afterward to release
		// upgraded WebSockets, which HTTP shutdown does not manage.
		_ = s.lanListener.Close()
		_ = s.lanServer.Shutdown(ctx)
		s.cancelLAN()
	}
	s.lanListener, s.lanServer, s.cancelLAN = nil, nil, nil
	s.lanPort, s.lanActive = 0, false
	if s.discoveryService != nil {
		s.discoveryService.Close()
		s.discoveryService = nil
	}
	s.discoveryError = ""
}

func (s *Server) startDiscoveryLocked(ctx context.Context) error {
	service, err := s.startDiscovery(ctx, s.lanIP, s.roomAdvertisements)
	s.discoveryError = discovery.ErrorCode(err)
	if err == nil {
		s.discoveryService = service
	}
	return err
}

func (s *Server) switchNetwork(ip string) (lanState, error) {
	var state lanState
	err := s.hub.WithIdleNetwork(func() error {
		s.lifecycleMu.Lock()
		parent := s.runContext
		s.lifecycleMu.Unlock()
		s.lanMu.Lock()
		defer s.lanMu.Unlock()
		if parent == nil || parent.Err() != nil {
			return errors.New("本机服务尚未就绪，请稍后再试")
		}
		select {
		case <-s.shutdownRequested:
			return errors.New("本机程序正在退出")
		default:
		}
		state = s.networkStateLocked()
		if !slices.ContainsFunc(state.LANInterfaces, func(face LANInterface) bool { return face.IPv4 == ip }) {
			return errNetworkUnavailable
		}
		save := func() error {
			_, err := s.preferences.update(func(current Preferences) (Preferences, error) {
				current.PreferredLANIPv4 = ip
				return current, nil
			})
			if err != nil {
				return errors.New("无法保存首选网卡，请检查本机配置目录的写入权限")
			}
			return nil
		}
		if ip == s.lanIP && s.lanActive && s.discoveryService != nil {
			if err := save(); err != nil {
				return err
			}
			s.lanAutoSelected = false
			state.LANAutoSelected = false
			return nil
		}

		previousIP, previousPort, previousActive := s.lanIP, s.lanPort, s.lanActive
		stopCtx, cancel := context.WithTimeout(context.Background(), 750*time.Millisecond)
		defer cancel()
		s.stopLANLocked(stopCtx)
		s.lanIP = ip
		nextRelay := screenrelay.New(ip)
		_, startErr := s.startLANLocked(parent, s.config.SignalPort)
		if startErr != nil {
			startErr = fmt.Errorf("无法启动新网卡的房间信令（%s）", appErrorCode(startErr))
		} else if err := s.startDiscoveryLocked(parent); err != nil {
			startErr = fmt.Errorf("无法启动新网卡的附近房间查找（%s）", discovery.ErrorCode(err))
		} else {
			startErr = save()
		}
		if startErr == nil {
			s.screens.Close()
			s.screens = nextRelay
			s.lanAutoSelected = false
			state = s.networkStateLocked()
			return nil
		}

		nextRelay.Close()
		s.stopLANLocked(stopCtx)
		s.lanIP = previousIP
		var rollbackSignalErr error
		if previousActive {
			_, rollbackSignalErr = s.startLANLocked(parent, previousPort)
		}
		var rollbackDiscoveryErr error
		if previousIP != "" {
			rollbackDiscoveryErr = s.startDiscoveryLocked(parent)
		}
		if rollbackSignalErr != nil || rollbackDiscoveryErr != nil {
			return fmt.Errorf("%w。原网卡服务恢复失败，请刷新页面或重新打开程序", startErr)
		}
		return fmt.Errorf("%w。已恢复原网卡", startErr)
	})
	return state, err
}

var errNetworkUnavailable = errors.New("该网卡已不可用，请刷新后重新选择")

func (s *Server) serveNetwork(w http.ResponseWriter, r *http.Request) {
	if !s.validControlPOST(r) {
		writeError(w, http.StatusForbidden, "AUTH_REQUIRED", "网卡切换仅供本机程序页面使用", false)
		return
	}
	body := http.MaxBytesReader(w, r.Body, 1024)
	defer body.Close()
	var request struct {
		LANIPv4 string `json:"lanIPv4"`
	}
	decoder := json.NewDecoder(body)
	decoder.DisallowUnknownFields()
	var extra any
	if decoder.Decode(&request) != nil || decoder.Decode(&extra) != io.EOF || !validPrivateIPv4(request.LANIPv4) {
		writeError(w, http.StatusBadRequest, "INVALID_HOST_ADDRESS", "请选择可用的局域网网卡", false)
		return
	}
	state, err := s.switchNetwork(request.LANIPv4)
	switch {
	case errors.Is(err, signal.ErrNetworkBusy):
		writeError(w, http.StatusConflict, "NETWORK_BUSY", "请先离开或结束当前房间再切换局域网网卡", false)
	case errors.Is(err, errNetworkUnavailable):
		writeError(w, http.StatusBadRequest, "NETWORK_INTERFACE_UNAVAILABLE", err.Error(), true)
	case err != nil:
		writeError(w, http.StatusServiceUnavailable, "NETWORK_SWITCH_FAILED", err.Error(), true)
	default:
		writeJSON(w, state)
	}
}
