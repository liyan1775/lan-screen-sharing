package discovery

import (
	"net"
	"syscall"
)

func reuseDiscoveryPort(_, _ string, raw syscall.RawConn) error {
	var result error
	if err := raw.Control(func(fd uintptr) {
		result = syscall.SetsockoptInt(syscall.Handle(fd), syscall.SOL_SOCKET, syscall.SO_REUSEADDR, 1)
	}); err != nil {
		return err
	}
	return result
}

func configureMulticast(receiver, sender *net.UDPConn) error {
	for _, option := range []struct {
		conn        *net.UDPConn
		name, value int
	}{{receiver, syscall.IP_MULTICAST_LOOP, 1}, {sender, syscall.IP_MULTICAST_TTL, 1}} {
		raw, err := option.conn.SyscallConn()
		if err != nil {
			return err
		}
		var result error
		if err = raw.Control(func(fd uintptr) {
			result = syscall.SetsockoptInt(syscall.Handle(fd), syscall.IPPROTO_IP, option.name, option.value)
		}); err != nil {
			return err
		}
		if result != nil {
			return result
		}
	}
	raw, err := sender.SyscallConn()
	if err != nil {
		return err
	}
	var result error
	var address [4]byte
	copy(address[:], sender.LocalAddr().(*net.UDPAddr).IP.To4())
	if err = raw.Control(func(fd uintptr) {
		result = syscall.SetsockoptInet4Addr(syscall.Handle(fd), syscall.IPPROTO_IP, syscall.IP_MULTICAST_IF, address)
	}); err != nil {
		return err
	}
	return result
}
