package signal

import (
	"fmt"
	"testing"
	"time"
)

func TestJoinFailureLimiterThresholdIsPerIPAndSuccessIsNotCounted(t *testing.T) {
	limiter := newJoinFailureLimiter()
	for attempt := 1; attempt <= 4; attempt++ {
		if !limiter.begin("192.168.1.10") {
			t.Fatalf("attempt %d was blocked early", attempt)
		}
		limiter.finish("192.168.1.10", false)
	}
	if !limiter.begin("192.168.1.10") {
		t.Fatal("a successful valid join was blocked before evaluation")
	}
	limiter.finish("192.168.1.10", true)
	if !limiter.begin("192.168.1.10") {
		t.Fatal("successful join was incorrectly counted as a failure")
	}
	limiter.finish("192.168.1.10", false)
	if limiter.begin("192.168.1.10") {
		t.Fatal("sixth failed attempt was allowed")
	}
	if !limiter.begin("192.168.1.11") {
		t.Fatal("one source IP's failures affected another source IP")
	}
	limiter.finish("192.168.1.11", true)
}

func TestJoinFailureLimiterExpiresFailuresAndCleansTTL(t *testing.T) {
	now := time.Unix(100, 0)
	limiter := newJoinFailureLimiter()
	limiter.now = func() time.Time { return now }
	for i := 0; i < maxFailedJoinsPerIP; i++ {
		if !limiter.begin("192.168.1.20") {
			t.Fatalf("attempt %d blocked early", i+1)
		}
		limiter.finish("192.168.1.20", false)
	}
	now = now.Add(failedJoinWindow - time.Nanosecond)
	if limiter.begin("192.168.1.20") {
		t.Fatal("failures expired before the full one-minute window")
	}
	now = now.Add(time.Nanosecond)
	if !limiter.begin("192.168.1.20") {
		t.Fatal("expired failure window did not allow a new attempt")
	}
	if len(limiter.entries) != 1 || limiter.entries["192.168.1.20"].pending != 1 {
		t.Fatalf("expired state was not pruned before creating the new reservation: %#v", limiter.entries)
	}
	limiter.finish("192.168.1.20", true)
	if len(limiter.entries) != 0 {
		t.Fatalf("successful attempt left a stale TTL entry: %#v", limiter.entries)
	}
}

func TestJoinFailureLimiterBoundsSourceState(t *testing.T) {
	now := time.Unix(200, 0)
	limiter := newJoinFailureLimiter()
	limiter.now = func() time.Time { return now }
	for i := 0; i < maxJoinLimiterIPs; i++ {
		ip := fmt.Sprintf("10.%d.%d.%d", (i>>16)&255, (i>>8)&255, i&255)
		if !limiter.begin(ip) {
			t.Fatalf("source %d blocked before state cap", i)
		}
		limiter.finish(ip, false)
	}
	if limiter.begin("10.255.255.255") {
		t.Fatal("limiter accepted state beyond the configured source bound")
	}
	if got := len(limiter.entries); got != maxJoinLimiterIPs {
		t.Fatalf("source state grew beyond its bound: %d", got)
	}
	now = now.Add(failedJoinWindow)
	if !limiter.begin("10.255.255.255") {
		t.Fatal("source state did not recover after TTL expiration")
	}
	if got := len(limiter.entries); got != 1 {
		t.Fatalf("expired source entries were not cleaned: %d remain", got)
	}
}

func TestConnectionSourceIPUsesSocketRemoteAddress(t *testing.T) {
	if got := connectionSourceIP("192.168.1.7:50231"); got != "192.168.1.7" {
		t.Fatalf("socket IP parse = %q", got)
	}
	if got := connectionSourceIP("[::ffff:192.168.1.7]:50231"); got != "192.168.1.7" {
		t.Fatalf("mapped IPv4 normalization = %q", got)
	}
	if got := connectionSourceIP("spoofed"); got != "" {
		t.Fatalf("invalid remote address accepted: %q", got)
	}
}
