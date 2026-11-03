package main

import (
	"errors"
	"net"
	"testing"
)

func TestNoBrowserOpenFlag(t *testing.T) {
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
	for _, target := range []string{"http://192.168.1.2:8123/", "http://localhost.evil:8123/", "https://localhost:8123/", "http://localhost:8123/path"} {
		called = ""
		if err := openLocalBrowser(target, opener); err == nil || called != "" {
			t.Fatalf("accepted non-local browser URL %q", target)
		}
	}
	if err := openLocalBrowser("http://localhost:8123/", func(string) error { return errors.New("opener failure") }); err == nil {
		t.Fatal("opener failure was hidden")
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
