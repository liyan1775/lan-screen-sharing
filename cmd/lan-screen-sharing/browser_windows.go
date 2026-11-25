package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows/registry"
)

type chromiumBrowser struct {
	exe, installDir string
}

func chromiumBrowserOrder(progID string) [2]chromiumBrowser {
	edge := chromiumBrowser{"msedge.exe", `Microsoft\Edge\Application`}
	chrome := chromiumBrowser{"chrome.exe", `Google\Chrome\Application`}
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(progID)), "chromehtml") {
		return [2]chromiumBrowser{chrome, edge}
	}
	return [2]chromiumBrowser{edge, chrome}
}

func launchWindowsBrowser(target, progID string, find func(chromiumBrowser) string, start func(string, ...string) error) error {
	for _, browser := range chromiumBrowserOrder(progID) {
		if path := find(browser); path != "" {
			if err := start(path, "--app="+target); err == nil {
				return nil
			}
			break
		}
	}
	return start("rundll32.exe", "url.dll,FileProtocolHandler", target)
}

func systemBrowserOpen(target string) error {
	const httpsUserChoice = `Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice`
	progID := registryString(registry.CURRENT_USER, httpsUserChoice, "ProgId", registry.QUERY_VALUE)
	return launchWindowsBrowser(target, progID, findChromiumBrowser, func(path string, args ...string) error {
		return exec.Command(path, args...).Start()
	})
}

func findChromiumBrowser(browser chromiumBrowser) string {
	key := `Software\Microsoft\Windows\CurrentVersion\App Paths\` + browser.exe
	for _, root := range []registry.Key{registry.CURRENT_USER, registry.LOCAL_MACHINE} {
		for _, view := range []uint32{registry.WOW64_64KEY, registry.WOW64_32KEY} {
			path := strings.Trim(strings.TrimSpace(registryString(root, key, "", registry.QUERY_VALUE|view)), `"`)
			if isBrowserExecutable(path, browser.exe) {
				return path
			}
		}
	}
	for _, env := range []string{"ProgramFiles", "ProgramFiles(x86)", "LocalAppData"} {
		if dir := os.Getenv(env); dir != "" {
			path := filepath.Join(dir, browser.installDir, browser.exe)
			if isBrowserExecutable(path, browser.exe) {
				return path
			}
		}
	}
	return ""
}

func isBrowserExecutable(path, exe string) bool {
	if !filepath.IsAbs(path) || !strings.EqualFold(filepath.Base(path), exe) {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

func registryString(root registry.Key, path, name string, access uint32) string {
	key, err := registry.OpenKey(root, path, access)
	if err != nil {
		return ""
	}
	defer key.Close()
	value, kind, err := key.GetStringValue(name)
	if err != nil {
		return ""
	}
	if kind == registry.EXPAND_SZ {
		value, err = registry.ExpandString(value)
		if err != nil {
			return ""
		}
	}
	return value
}
