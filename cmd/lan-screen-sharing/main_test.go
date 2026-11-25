package main

import (
	"errors"
	"net"
	"path/filepath"
	"reflect"
	"testing"
)

func TestNoBrowserOpenFlag(t *testing.T) {
	defaults, err := parseLaunchOptions(nil)
	if err != nil || !defaults.openBrowser {
		t.Fatalf("browser should open by default: %#v, %v", defaults, err)
	}
	options, err := parseLaunchOptions([]string{"--open-browser=false", "--port=8123"})
	if err != nil {
		t.Fatal(err)
	}
	if options.openBrowser || options.port != 8123 {
		t.Fatalf("unexpected options: %#v", options)
	}
}

func TestBrowserOpenUsesLocalhostOnly(t *testing.T) {
	called := ""
	opener := func(target string) error { called = target; return nil }
	if err := openLocalBrowser("http://localhost:8123/", opener); err != nil {
		t.Fatal(err)
	}
	if called != "http://localhost:8123/" {
		t.Fatalf("opener got %q", called)
	}
	for _, target := range []string{
		"http://192.168.1.2:8123/", "http://localhost.evil:8123/", "https://localhost:8123/",
		"http://localhost:8123/path", "http://localhost:8123/%2f", "http://localhost:8123/?", "http://localhost:8123/#",
		"http://user@localhost:8123/", "http://localhost/", "http://localhost:0/", "http://localhost:65536/",
		"http://localhost:8123/ --flag", "http://localhost:8123", "http://localhost:+8123/",
	} {
		called = ""
		if err := openLocalBrowser(target, opener); err == nil || called != "" {
			t.Fatalf("accepted non-local browser URL %q", target)
		}
	}
	if err := openLocalBrowser("http://localhost:8123/", func(string) error { return errors.New("opener failure") }); err == nil {
		t.Fatal("opener failure was hidden")
	}
}

func TestLaunchWindowsBrowser(t *testing.T) {
	const target = "http://localhost:8123/"
	chromePath := filepath.Join(`C:\Program Files`, "Google", "chrome.exe")
	edgePath := filepath.Join(`C:\Program Files (x86)`, "Microsoft", "msedge.exe")
	type command struct {
		path string
		args []string
	}
	chromeApp := command{chromePath, []string{"--app=http://localhost:8123/"}}
	edgeApp := command{edgePath, []string{"--app=http://localhost:8123/"}}
	fallback := command{"rundll32.exe", []string{"url.dll,FileProtocolHandler", target}}
	startErr := errors.New("launch failed")
	for _, tt := range []struct {
		name, progID string
		chrome, edge bool
		failApp      bool
		fallbackErr  error
		wantLookups  []string
		wantCommands []command
	}{
		{"chrome default", "ChromeHTML", true, true, false, nil, []string{"chrome.exe"}, []command{chromeApp}},
		{"chrome variant", "chromehtml.ABC", true, true, false, nil, []string{"chrome.exe"}, []command{chromeApp}},
		{"edge default", "MSEdgeHTM", true, true, false, nil, []string{"msedge.exe"}, []command{edgeApp}},
		{"another browser default", "FirefoxURL", true, true, false, nil, []string{"msedge.exe"}, []command{edgeApp}},
		{"chrome missing", "ChromeHTML", false, true, false, nil, []string{"chrome.exe", "msedge.exe"}, []command{edgeApp}},
		{"edge missing", "", true, false, false, nil, []string{"msedge.exe", "chrome.exe"}, []command{chromeApp}},
		{"both missing", "", false, false, false, nil, []string{"msedge.exe", "chrome.exe"}, []command{fallback}},
		{"app start fails", "ChromeHTML", true, true, true, nil, []string{"chrome.exe"}, []command{chromeApp, fallback}},
		{"fallback fails", "", false, false, false, startErr, []string{"msedge.exe", "chrome.exe"}, []command{fallback}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			var lookups []string
			var commands []command
			find := func(browser chromiumBrowser) string {
				lookups = append(lookups, browser.exe)
				switch browser.exe {
				case "chrome.exe":
					if tt.chrome {
						return chromePath
					}
				case "msedge.exe":
					if tt.edge {
						return edgePath
					}
				}
				return ""
			}
			start := func(path string, args ...string) error {
				commands = append(commands, command{path, args})
				if path == fallback.path {
					return tt.fallbackErr
				}
				if tt.failApp {
					return startErr
				}
				return nil
			}
			if err := launchWindowsBrowser(target, tt.progID, find, start); err != tt.fallbackErr {
				t.Errorf("launch error = %v, want %v", err, tt.fallbackErr)
			}
			if !reflect.DeepEqual(lookups, tt.wantLookups) {
				t.Errorf("browser lookups = %q, want %q", lookups, tt.wantLookups)
			}
			if !reflect.DeepEqual(commands, tt.wantCommands) {
				t.Errorf("commands = %+v, want %+v", commands, tt.wantCommands)
			}
		})
	}
}

func TestLocalPageURLUsesLocalhost(t *testing.T) {
	addr, err := net.ResolveTCPAddr("tcp4", "127.0.0.1:32145")
	if err != nil {
		t.Fatal(err)
	}
	if got := localPageURL(addr); got != "http://localhost:32145/" {
		t.Fatalf("URL=%q", got)
	}
}
