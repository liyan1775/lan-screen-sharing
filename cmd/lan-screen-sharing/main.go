package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"lan-screen-sharing/internal/app"
)

type launchOptions struct {
	lanIP            string
	signalPort, port int
	openBrowser      bool
	showVersion      bool
}

var version = "dev"

func parseLaunchOptions(args []string) (launchOptions, error) {
	var options launchOptions
	fs := flag.NewFlagSet("lan-screen-sharing", flag.ContinueOnError)
	fs.StringVar(&options.lanIP, "lan-ip", "", "override the preferred or automatically recommended private IPv4")
	fs.IntVar(&options.signalPort, "signal-port", 0, "LAN signaling port; 0 selects an ephemeral port")
	fs.IntVar(&options.port, "port", 0, "localhost UI port; 0 selects an available port")
	fs.BoolVar(&options.openBrowser, "open-browser", true, "open the local page in an app window when available")
	fs.BoolVar(&options.showVersion, "version", false, "print the build version")
	if err := fs.Parse(args); err != nil {
		return options, err
	}
	if options.port < 0 || options.port > 65535 {
		return options, errors.New("--port must be 0..65535")
	}
	if options.signalPort < 0 || options.signalPort > 65535 {
		return options, errors.New("--signal-port must be 0..65535")
	}
	return options, nil
}

func localPageURL(addr net.Addr) string {
	port := addr.(*net.TCPAddr).Port
	return fmt.Sprintf("http://localhost:%d/", port)
}

func openLocalBrowser(target string, opener func(string) error) error {
	const prefix = "http://localhost:"
	if len(target) > len(prefix)+1 && strings.EqualFold(target[:len(prefix)], prefix) && strings.HasSuffix(target, "/") {
		port, err := strconv.ParseUint(target[len(prefix):len(target)-1], 10, 16)
		if err == nil && port != 0 {
			return opener(target)
		}
	}
	return errors.New("browser URL must be http://localhost:<port>/")
}

func main() {
	options, err := parseLaunchOptions(os.Args[1:])
	if err != nil {
		log.Print(err)
		showStartupFallback("启动参数无效。请使用 --help 查看参数。")
		os.Exit(2)
	}
	if options.showVersion {
		fmt.Println(version)
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	srv := app.New(app.Config{LANIPv4: options.lanIP, SignalPort: options.signalPort})
	local, err := srv.StartAtPort(ctx, options.port, 10)
	if err != nil {
		log.Printf("本机页面启动失败：%v", err)
		showStartupFallback("本机页面启动失败。请关闭其他占用程序后重试。")
		return
	}
	pageURL := localPageURL(local.Addr())
	fmt.Printf("本机页面：%s\n", pageURL)
	if options.openBrowser {
		if err := openLocalBrowser(pageURL, systemBrowserOpen); err != nil {
			showStartupFallback("无法自动打开浏览器。请复制此地址到 Chrome 或 Edge：\n" + pageURL)
		}
	}
	select {
	case <-ctx.Done():
	case <-srv.ShutdownRequested():
	}
	stop()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown: %v", err)
	}
}
