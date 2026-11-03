package signal

import (
	"net"
	"net/netip"
	"strings"
	"sync"
	"time"
)

const (
	maxFailedJoinsPerIP = 5
	failedJoinWindow    = time.Minute
	maxJoinLimiterIPs   = 4096
)

type joinFailureEntry struct {
	failures []time.Time
	pending  int
}

type joinFailureLimiter struct {
	mu      sync.Mutex
	entries map[string]*joinFailureEntry
	now     func() time.Time
}

func newJoinFailureLimiter() *joinFailureLimiter {
	return &joinFailureLimiter{entries: make(map[string]*joinFailureEntry), now: time.Now}
}

// begin reserves one join attempt while the room manager checks it. Only failed
// room-code attempts are retained; successful joins release their reservation.
func (l *joinFailureLimiter) begin(sourceIP string) bool {
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	l.pruneExpired(now)
	entry := l.entries[sourceIP]
	if entry == nil {
		if len(l.entries) >= maxJoinLimiterIPs {
			return false
		}
		entry = &joinFailureEntry{}
		l.entries[sourceIP] = entry
	}
	if len(entry.failures)+entry.pending >= maxFailedJoinsPerIP {
		return false
	}
	entry.pending++
	return true
}

func (l *joinFailureLimiter) finish(sourceIP string, succeeded bool) {
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	entry := l.entries[sourceIP]
	if entry == nil {
		return
	}
	if entry.pending > 0 {
		entry.pending--
	}
	if !succeeded {
		entry.failures = append(entry.failures, now)
	}
	l.pruneExpired(now)
}

func (l *joinFailureLimiter) pruneExpired(now time.Time) {
	for ip, entry := range l.entries {
		kept := entry.failures[:0]
		for _, failedAt := range entry.failures {
			if now.Sub(failedAt) < failedJoinWindow {
				kept = append(kept, failedAt)
			}
		}
		entry.failures = kept
		if len(entry.failures) == 0 && entry.pending == 0 {
			delete(l.entries, ip)
		}
	}
}

func connectionSourceIP(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return ""
	}
	ip, err := netip.ParseAddr(strings.Trim(host, "[]"))
	if err != nil {
		return ""
	}
	return ip.Unmap().String()
}
