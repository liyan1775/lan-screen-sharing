package app

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
	"lan-screen-sharing/internal/discovery"
	"lan-screen-sharing/internal/screenrelay"
)

func TestLANRankingPrefersPhysicalAndKeepsPrivateVPNAdapters(t *testing.T) {
	names := []string{"WSL", "Hyper-V", "vEthernet", "VirtualBox", "VMware", "Docker", "Tailscale", "Clash", "WireGuard", "Meta", "TUN2", "TAP", "ZeroTier", "Loopback"}
	for _, name := range names {
		if !virtualInterface(name, net.FlagUp) {
			t.Errorf("%q should be recognized as virtual", name)
		}
	}
	enterprise := LANInterface{Name: "Ethernet", IPv4: "172.22.1.10"}
	vpn := LANInterface{Name: "Tailscale", IPv4: "10.8.0.2", Virtual: true}
	wlan := LANInterface{Name: "WLAN", IPv4: "192.168.1.10"}
	ranked := rankLANInterfaces([]LANInterface{vpn, wlan, enterprise, {Name: "Other", IPv4: "10.0.0.7"}})
	if len(ranked) != 4 || ranked[0].IPv4 != enterprise.IPv4 || !ranked[0].Recommended || ranked[3].IPv4 != vpn.IPv4 {
		t.Fatalf("unexpected LAN ranking: %+v", ranked)
	}
	if !validPrivateIPv4(enterprise.IPv4) || selectLANIPv4("", "", ranked) != enterprise.IPv4 ||
		selectLANIPv4("", vpn.IPv4, ranked) != vpn.IPv4 || selectLANIPv4(wlan.IPv4, vpn.IPv4, ranked) != wlan.IPv4 ||
		selectLANIPv4("", "192.168.200.200", ranked) != enterprise.IPv4 || selectLANIPv4("", "", nil) != "" ||
		selectLANIPv4("", "", []LANInterface{vpn}) != vpn.IPv4 {
		t.Fatal("automatic, remembered and explicit adapter priorities differ")
	}
}

type testDiscoveryGeneration struct {
	ip        string
	closed    bool
	rooms     []discovery.Room
	peers     []string
	refreshes int
}

func (d *testDiscoveryGeneration) Close()                        { d.closed = true }
func (d *testDiscoveryGeneration) Rooms() []discovery.Room       { return d.rooms }
func (d *testDiscoveryGeneration) SetDirectPeers(peers []string) { d.peers = peers }
func (d *testDiscoveryGeneration) Refresh() bool                 { d.refreshes++; return true }
func (d *testDiscoveryGeneration) Diagnostics() discovery.Diagnostics {
	return discovery.Diagnostics{LocalIPv4: d.ip, Running: !d.closed}
}

func networkTestServer(t *testing.T) (*Server, context.Context, *net.TCPAddr, *[]*testDiscoveryGeneration) {
	t.Helper()
	faces := []LANInterface{{Name: "WLAN", IPv4: "192.168.99.20"}, {Name: "企业 Ethernet", IPv4: "172.22.1.10"}}
	s := New(Config{LANIPv4: faces[0].IPv4, PreferencesPath: filepath.Join(t.TempDir(), "preferences.json")})
	s.listLANInterfaces = func() []LANInterface { return faces }
	s.listenLAN = func(_ string, port int) (net.Listener, error) {
		return net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: port})
	}
	var generations []*testDiscoveryGeneration
	s.startDiscovery = func(_ context.Context, ip string, _ func() []discovery.Advertisement) (lanDiscovery, error) {
		generation := &testDiscoveryGeneration{ip: ip}
		generations = append(generations, generation)
		return generation, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() { _ = s.Shutdown(context.Background()); cancel() })
	localhost, err := s.Start(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.StartLAN(ctx); err != nil {
		t.Fatal(err)
	}
	return s, ctx, localhost.Addr().(*net.TCPAddr), &generations
}

func switchTestNetwork(s *Server, target string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, localControlRequest(s, "/api/v1/network", `{"lanIPv4":"`+target+`"}`))
	return w
}

func TestLANSwitchReplacesSignalingDiscoveryAndRelayWithoutStoppingLocalhost(t *testing.T) {
	s, ctx, local, generations := networkTestServer(t)
	oldSignal, oldRelay := s.lanListener, s.screens
	oldDiscovery := (*generations)[0]
	oldDiscovery.rooms = []discovery.Room{{ID: "obsolete-room"}}
	peers := []string{"10.208.141.20"}
	saved := httptest.NewRecorder()
	s.Handler().ServeHTTP(saved, localControlRequest(s, "/api/v1/preferences", `{"peerHosts":["10.208.141.20"]}`))
	if saved.Code != http.StatusOK || !slices.Equal(oldDiscovery.peers, peers) {
		t.Fatalf("could not configure peers on existing generation: %d %s", saved.Code, saved.Body)
	}
	w := switchTestNetwork(s, "172.22.1.10")
	var selected lanState
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &selected) != nil || selected.LANIPv4 != "172.22.1.10" ||
		selected.SignalPort == 0 || s.lanListener == oldSignal || s.screens == oldRelay ||
		!slices.ContainsFunc(selected.LANInterfaces, func(face LANInterface) bool { return face.IPv4 == selected.LANIPv4 && face.Active }) {
		t.Fatalf("network did not change generations: %d %s", w.Code, w.Body)
	}
	_ = oldSignal.(*net.TCPListener).SetDeadline(time.Now().Add(time.Second))
	if _, err := oldSignal.Accept(); !errors.Is(err, net.ErrClosed) || !oldDiscovery.closed || len(*generations) != 2 || len(s.discoveryService.Rooms()) != 0 {
		t.Fatalf("old LAN listener or discovery cache is live: %v", err)
	}
	if next := (*generations)[1]; !slices.Equal(next.peers, peers) || next.refreshes != 1 {
		t.Fatalf("peer settings did not trigger a probe on the new network: %+v", next)
	}
	if _, _, err := oldRelay.Start(ctx, webrtc.SessionDescription{}); !errors.Is(err, screenrelay.ErrSession) {
		t.Fatalf("old relay is still usable: %v", err)
	}
	if got := openPreferences(s.preferences.path).snapshot().PreferredLANIPv4; got != selected.LANIPv4 {
		t.Fatalf("network preference not persisted: %q", got)
	}
	client := &http.Client{Timeout: time.Second}
	response, err := client.Get("http://" + local.String() + "/")
	if err != nil {
		t.Fatalf("switch stopped the local application: %v", err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK || ctx.Err() != nil {
		t.Fatalf("original local page did not survive: %d %v", response.StatusCode, ctx.Err())
	}
}

func TestLANSwitchRejectsLiveAndRecoveringRooms(t *testing.T) {
	s, _, _, _ := networkTestServer(t)
	snapshot, _, err := s.rooms.CreateHost()
	if err != nil {
		t.Fatal(err)
	}
	checkConflict := func() {
		t.Helper()
		w := switchTestNetwork(s, "172.22.1.10")
		if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "请先离开或结束当前房间再切换局域网网卡") {
			t.Fatalf("want room conflict, got %d %s", w.Code, w.Body)
		}
	}
	checkConflict()
	s.rooms.Disconnect(snapshot.ID, snapshot.Members[0].PeerID)
	checkConflict()
	s.rooms.End(snapshot.ID)
	if w := switchTestNetwork(s, "172.22.1.10"); w.Code != http.StatusOK {
		t.Fatalf("switch after room ended: %d %s", w.Code, w.Body)
	}
}

func TestLANSwitchRollsBackOnFailure(t *testing.T) {
	const target = "172.22.1.10"
	failures := map[string]func(*testing.T, *Server){
		"signaling": func(_ *testing.T, s *Server) {
			listen := s.listenLAN
			s.listenLAN = func(ip string, port int) (net.Listener, error) {
				if ip == target {
					return nil, errors.New("PORT_IN_USE")
				}
				return listen(ip, port)
			}
		},
		"discovery": func(_ *testing.T, s *Server) {
			start := s.startDiscovery
			s.startDiscovery = func(ctx context.Context, ip string, advertise func() []discovery.Advertisement) (lanDiscovery, error) {
				if ip == target {
					return nil, errors.New("NETWORK_INTERFACE_UNAVAILABLE")
				}
				return start(ctx, ip, advertise)
			}
		},
		"preferences": func(t *testing.T, s *Server) {
			s.preferences.path = t.TempDir() // Replacing a directory with the preference file must fail.
		},
	}
	for name, fail := range failures {
		t.Run(name, func(t *testing.T) {
			s, _, _, generations := networkTestServer(t)
			oldIP, oldPort, oldSignal, oldRelay := s.lanIP, s.lanPort, s.lanListener, s.screens
			fail(t, s)
			w := switchTestNetwork(s, target)
			if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "已恢复原网卡") ||
				s.lanIP != oldIP || s.lanPort != oldPort || s.lanListener == oldSignal || s.screens != oldRelay ||
				s.preferences.snapshot().PreferredLANIPv4 != "" || !(*generations)[0].closed ||
				(*generations)[len(*generations)-1].ip != oldIP ||
				slices.ContainsFunc(*generations, func(g *testDiscoveryGeneration) bool { return g.ip == target && !g.closed }) {
				t.Fatalf("failed switch did not roll back LAN: %d %s", w.Code, w.Body)
			}
			probe, err := net.DialTimeout("tcp4", s.lanListener.Addr().String(), time.Second)
			if err != nil {
				t.Fatalf("rolled-back signal port did not reopen: %v", err)
			}
			probe.Close()
		})
	}
}
