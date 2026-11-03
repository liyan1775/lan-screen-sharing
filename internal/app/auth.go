package app

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"net"
	"net/http"
	"net/url"
	"strings"
)

func newHostToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func (s *Server) authorizeHost(r *http.Request, token string) bool {
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || net.ParseIP(ip) == nil || !net.ParseIP(ip).IsLoopback() {
		return false
	}
	if len(token) != len(s.hostToken) || len(token) == 0 {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(token), []byte(s.hostToken)) == 1
}

func validLocalBrowserRequest(r *http.Request) bool {
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || net.ParseIP(ip) == nil || !net.ParseIP(ip).IsLoopback() {
		return false
	}
	host := requestHost(r.Host)
	if !isLoopbackName(host) {
		return false
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return false
	}
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	if !strings.EqualFold(requestHost(u.Host), host) {
		return false
	}
	return strings.EqualFold(normalizeHostPort(u.Host), normalizeHostPort(r.Host))
}

func validLocalBootstrapRequest(r *http.Request) bool {
	if r.Header.Get("Origin") != "" {
		return validLocalBrowserRequest(r)
	}
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || net.ParseIP(ip) == nil || !net.ParseIP(ip).IsLoopback() || !isLoopbackName(requestHost(r.Host)) {
		return false
	}
	if r.Header.Get("Sec-Fetch-Site") != "same-origin" {
		return false
	}
	ref, err := url.Parse(r.Referer())
	if err != nil || ref.Scheme != "http" || ref.User != nil {
		return false
	}
	return strings.EqualFold(requestHost(ref.Host), requestHost(r.Host)) && strings.EqualFold(normalizeHostPort(ref.Host), normalizeHostPort(r.Host))
}

func normalizeHostPort(hostport string) string {
	if host, port, err := net.SplitHostPort(hostport); err == nil {
		return strings.ToLower(strings.TrimSuffix(host, ".")) + ":" + port
	}
	return strings.ToLower(strings.TrimSuffix(hostport, "."))
}

func requestHost(hostport string) string {
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		return strings.TrimSuffix(strings.ToLower(h), ".")
	}
	return strings.TrimSuffix(strings.ToLower(hostport), ".")
}

func isLoopbackName(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
