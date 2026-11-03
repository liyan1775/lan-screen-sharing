package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"lan-screen-sharing/internal/protocol"
)

func TestPortConflictUsesBoundedRetry(t *testing.T) {
	occupied, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	port := occupied.Addr().(*net.TCPAddr).Port
	srv := New(Config{})
	ln, err := srv.StartAtPort(context.Background(), port, 3)
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Shutdown(context.Background())
	got := ln.Addr().(*net.TCPAddr).Port
	if got == port || got > port+2 {
		t.Fatalf("retry escaped bounded port range: start=%d got=%d", port, got)
	}
}

func TestHostRoomCreationStartsLANListener(t *testing.T) {
	ip := firstPrivateIPv4()
	if ip == "" {
		t.Skip("no usable private IPv4 available")
	}
	srv := New(Config{LANIPv4: ip})
	local, err := srv.StartAtPort(context.Background(), 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Shutdown(context.Background())
	origin := "http://" + local.Addr().String()
	preRoom := httptest.NewRequest("GET", origin+"/api/v1/bootstrap?role=host", nil)
	preRoom.RemoteAddr = "127.0.0.1:1234"
	preRoom.Host = local.Addr().String()
	preRoom.Header.Set("Origin", origin)
	preRoomResponse := httptest.NewRecorder()
	srv.Handler().ServeHTTP(preRoomResponse, preRoom)
	var before Bootstrap
	if err := json.Unmarshal(preRoomResponse.Body.Bytes(), &before); err != nil {
		t.Fatal(err)
	}
	if before.LANIPv4 != "" || before.SignalPort != 0 {
		t.Fatalf("LAN listener started before a room existed: %#v", before)
	}
	conn := dialAppLocal(t, "ws://"+local.Addr().String()+"/ws/v1", origin)
	defer conn.Close(websocket.StatusNormalClosure, "test complete")
	writeEnvelope(t, conn, protocol.Envelope{V: 1, Type: "auth.hello", RequestID: "auth-host-room", Payload: rawPayload(map[string]any{"role": "host", "hostToken": srv.hostToken})})
	readUntilType(t, conn, "room.state")
	writeEnvelope(t, conn, protocol.Envelope{V: 1, Type: "host.createRoom", RequestID: "create-host-room", Payload: rawPayload(map[string]any{})})
	created := readType(t, conn, "room.created")
	if created.Type != "room.created" {
		t.Fatalf("room create response: %#v", created)
	}
	r := httptest.NewRequest("GET", origin+"/api/v1/bootstrap?role=host", nil)
	r.RemoteAddr = "127.0.0.1:1234"
	r.Host = local.Addr().String()
	r.Header.Set("Origin", origin)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)
	var bootstrap Bootstrap
	if err := json.Unmarshal(w.Body.Bytes(), &bootstrap); err != nil {
		t.Fatal(err)
	}
	if w.Code != http.StatusOK || bootstrap.LANIPv4 != ip || bootstrap.SignalPort == 0 {
		t.Fatalf("host room did not publish active LAN listener: status=%d bootstrap=%#v", w.Code, bootstrap)
	}
}

func TestGracefulShutdownClosesListenersAndRooms(t *testing.T) {
	srv := New(Config{})
	roomSnapshot, _, err := srv.Rooms().CreateHost()
	if err != nil {
		t.Fatal(err)
	}
	ln, err := srv.StartAtPort(context.Background(), 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	shutdownReq := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/api/v1/shutdown", nil)
	shutdownReq.RemoteAddr = "127.0.0.1:1234"
	shutdownReq.Host = "127.0.0.1:8080"
	shutdownReq.Header.Set("Origin", "http://127.0.0.1:8080")
	shutdownReq.Header.Set("X-Local-Control-Token", srv.localControlToken)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, shutdownReq)
	if w.Code != http.StatusAccepted {
		t.Fatalf("shutdown status=%d body=%s", w.Code, w.Body.String())
	}
	select {
	case <-srv.ShutdownRequested():
	case <-time.After(time.Second):
		t.Fatal("shutdown request was not signaled")
	}
	if err := srv.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := net.DialTimeout("tcp", ln.Addr().String(), 100*time.Millisecond); err == nil {
		t.Fatal("listener remained open")
	}
	if _, ok := srv.Rooms().Get(roomSnapshot.ID); ok {
		t.Fatal("room remained active after shutdown")
	}
}

type shutdownOrderRecorder struct {
	*httptest.ResponseRecorder
	shutdownRequested   <-chan struct{}
	flushedBeforeSignal bool
}

func (w *shutdownOrderRecorder) Flush() {
	select {
	case <-w.shutdownRequested:
	default:
		w.flushedBeforeSignal = true
	}
	w.ResponseRecorder.Flush()
}

func TestShutdownFlushesAcceptedResponseBeforeSignalingMainLoop(t *testing.T) {
	srv := New(Config{})
	origin := "http://127.0.0.1:8080"
	r := httptest.NewRequest(http.MethodPost, origin+"/api/v1/shutdown", nil)
	r.RemoteAddr = "127.0.0.1:1234"
	r.Host = "127.0.0.1:8080"
	r.Header.Set("Origin", origin)
	r.Header.Set("X-Local-Control-Token", srv.localControlToken)
	w := &shutdownOrderRecorder{ResponseRecorder: httptest.NewRecorder(), shutdownRequested: srv.ShutdownRequested()}

	srv.serveShutdown(w, r)

	if w.Code != http.StatusAccepted {
		t.Fatalf("shutdown status=%d, want %d", w.Code, http.StatusAccepted)
	}
	if !w.Flushed || !w.flushedBeforeSignal {
		t.Fatal("shutdown response was not flushed before notifying the main loop")
	}
	select {
	case <-srv.ShutdownRequested():
	default:
		t.Fatal("successful shutdown response did not notify the main loop")
	}
}

type observedShutdownContext struct {
	context.Context
	entered chan struct{}
	once    sync.Once
}

func (c *observedShutdownContext) Done() <-chan struct{} {
	c.once.Do(func() { close(c.entered) })
	return c.Context.Done()
}

type shutdownObservation struct {
	err                   error
	returnedBeforeRelease bool
}

func TestConcurrentShutdownWaitsForActiveShutdownToComplete(t *testing.T) {
	srv := New(Config{})
	handlerStarted := make(chan struct{})
	releaseHandler := make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(releaseHandler) }) }
	srv.Handler().(*http.ServeMux).HandleFunc("/hold", func(w http.ResponseWriter, r *http.Request) {
		close(handlerStarted)
		<-releaseHandler
		w.WriteHeader(http.StatusNoContent)
	})
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	hs := &http.Server{Handler: srv.Handler(), ReadHeaderTimeout: 5 * time.Second}
	srv.lifecycleMu.Lock()
	srv.listeners = append(srv.listeners, ln)
	srv.httpServers = append(srv.httpServers, hs)
	srv.lifecycleMu.Unlock()
	go func() { _ = hs.Serve(ln) }()
	t.Cleanup(func() {
		release()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	})

	responseDone := make(chan error, 1)
	go func() {
		response, requestErr := http.Get("http://" + ln.Addr().String() + "/hold")
		if requestErr != nil {
			responseDone <- requestErr
			return
		}
		response.Body.Close()
		if response.StatusCode != http.StatusNoContent {
			responseDone <- fmt.Errorf("held handler status=%d, want %d", response.StatusCode, http.StatusNoContent)
			return
		}
		responseDone <- nil
	}()
	select {
	case <-handlerStarted:
	case <-time.After(time.Second):
		t.Fatal("request did not reach the controlled active handler")
	}

	shutdownEntered := make(chan struct{})
	hs.RegisterOnShutdown(func() { close(shutdownEntered) })
	firstDone := make(chan error, 1)
	go func() { firstDone <- srv.Shutdown(context.Background()) }()
	select {
	case <-shutdownEntered:
	case <-time.After(time.Second):
		t.Fatal("first Shutdown did not close the listener while handler was active")
	}

	waitContext := &observedShutdownContext{Context: context.Background(), entered: make(chan struct{})}
	secondDone := make(chan shutdownObservation, 1)
	go func() {
		shutdownErr := srv.Shutdown(waitContext)
		select {
		case <-releaseHandler:
			secondDone <- shutdownObservation{err: shutdownErr}
		default:
			secondDone <- shutdownObservation{err: shutdownErr, returnedBeforeRelease: true}
		}
	}()
	select {
	case observation := <-secondDone:
		t.Fatalf("second Shutdown returned before the active handler was released: %#v", observation)
	case <-waitContext.entered:
	case <-time.After(time.Second):
		t.Fatal("second Shutdown neither joined the in-flight shutdown nor returned")
	}

	release()
	select {
	case err := <-firstDone:
		if err != nil {
			t.Fatalf("first Shutdown: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("first Shutdown did not complete after the handler was released")
	}
	select {
	case observation := <-secondDone:
		if observation.returnedBeforeRelease || observation.err != nil {
			t.Fatalf("second Shutdown did not join successful completion: %#v", observation)
		}
	case <-time.After(time.Second):
		t.Fatal("second Shutdown did not complete after the first Shutdown")
	}
	if err := <-responseDone; err != nil {
		t.Fatalf("held request: %v", err)
	}
}

func TestShutdownRequiresSameOriginLoopbackAndNonce(t *testing.T) {
	srv := New(Config{})
	for _, tc := range []struct {
		name, remote, origin, token string
		want                        int
	}{
		{"valid", "127.0.0.1:1", "http://localhost:8000", srv.localControlToken, http.StatusAccepted},
		{"bad-token", "127.0.0.1:1", "http://localhost:8000", "no", http.StatusForbidden},
		{"lan", "192.168.1.2:1", "http://localhost:8000", srv.localControlToken, http.StatusForbidden},
		{"bad-origin", "127.0.0.1:1", "http://evil.example", srv.localControlToken, http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "http://localhost:8000/api/v1/shutdown", nil)
			r.RemoteAddr = tc.remote
			r.Host = "localhost:8000"
			r.Header.Set("Origin", tc.origin)
			r.Header.Set("X-Local-Control-Token", tc.token)
			w := httptest.NewRecorder()
			srv.Handler().ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("status=%d want=%d", w.Code, tc.want)
			}
		})
	}
}
