package discovery

import (
	"encoding/binary"
	"net"
	"net/netip"
	"strconv"
	"syscall"

	"golang.org/x/sys/windows"
)

func socketOption(conn *net.UDPConn, set func(syscall.Handle) error) error {
	raw, err := conn.SyscallConn()
	if err != nil {
		return err
	}
	var result error
	if err := raw.Control(func(fd uintptr) { result = set(syscall.Handle(fd)) }); err != nil {
		return err
	}
	return result
}

func enableBroadcast(conn *net.UDPConn) error {
	return socketOption(conn, func(fd syscall.Handle) error {
		return syscall.SetsockoptInt(fd, syscall.SOL_SOCKET, syscall.SO_BROADCAST, 1)
	})
}

func configureMulticast(sender *net.UDPConn) error {
	return socketOption(sender, func(fd syscall.Handle) error {
		if err := syscall.SetsockoptInt(fd, syscall.IPPROTO_IP, syscall.IP_MULTICAST_TTL, 1); err != nil {
			return err
		}
		address := sender.LocalAddr().(*net.UDPAddr).AddrPort().Addr().Unmap().As4()
		return syscall.SetsockoptInet4Addr(fd, syscall.IPPROTO_IP, syscall.IP_MULTICAST_IF, address)
	})
}

type windowsQuerySocket struct {
	*net.UDPConn
	interfaceIndex int
}

func newQuerySocket(conn *net.UDPConn, index int) udpSocket {
	if err := socketOption(conn, func(fd syscall.Handle) error {
		return syscall.SetsockoptInt(fd, syscall.IPPROTO_IP, windows.IP_PKTINFO, 1)
	}); err != nil {
		return conn
	}
	return &windowsQuerySocket{conn, index}
}

// Winsock WSACMSGHDR contains a pointer-sized length and two 32-bit ints.
// IN_PKTINFO contains a network-order IPv4 address and a native interface index.
const cmsgWordSize = strconv.IntSize / 8
const cmsgHeaderSize = cmsgWordSize + 8
const pktInfoSize = cmsgHeaderSize + 8

func (s *windowsQuerySocket) readQuery(data []byte) (int, *net.UDPAddr, netip.Addr, error) {
	var control [pktInfoSize]byte
	n, size, _, source, err := s.ReadMsgUDP(data, control[:])
	if err != nil || size < pktInfoSize ||
		binary.NativeEndian.Uint32(control[cmsgWordSize:]) != syscall.IPPROTO_IP ||
		binary.NativeEndian.Uint32(control[cmsgWordSize+4:]) != windows.IP_PKTINFO {
		return n, source, netip.Addr{}, err
	}
	address := netip.AddrFrom4([4]byte(control[cmsgHeaderSize:]))
	index := int(binary.NativeEndian.Uint32(control[cmsgHeaderSize+4:]))
	if index != s.interfaceIndex && (address.IsMulticast() || address == limitedBroadcastIP) {
		return n, nil, address, nil
	}
	return n, source, address, nil
}

type windowsSenderSocket struct {
	*net.UDPConn
	broadcastControl [pktInfoSize]byte
}

func newSenderSocket(conn *net.UDPConn, index int) udpSocket {
	sender := &windowsSenderSocket{UDPConn: conn}
	control := sender.broadcastControl[:]
	// The length fits in 32 bits and the upper half on 64-bit Windows is zero.
	binary.NativeEndian.PutUint32(control, pktInfoSize)
	binary.NativeEndian.PutUint32(control[cmsgWordSize:], syscall.IPPROTO_IP)
	binary.NativeEndian.PutUint32(control[cmsgWordSize+4:], windows.IP_PKTINFO)
	address := conn.LocalAddr().(*net.UDPAddr).AddrPort().Addr().Unmap().As4()
	copy(control[cmsgHeaderSize:], address[:])
	binary.NativeEndian.PutUint32(control[cmsgHeaderSize+4:], uint32(index))
	return sender
}

func (s *windowsSenderSocket) WriteToUDP(data []byte, destination *net.UDPAddr) (int, error) {
	if destination.AddrPort().Addr().Unmap() == limitedBroadcastIP {
		// Pin the all-host broadcast to the selected interface with WSASendMsg.
		n, _, err := s.WriteMsgUDP(data, s.broadcastControl[:], destination)
		return n, err
	}
	return s.UDPConn.WriteToUDP(data, destination)
}
