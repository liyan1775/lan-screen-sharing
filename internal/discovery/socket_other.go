//go:build !windows

package discovery

import (
	"net"
	"net/netip"
	"syscall"

	"golang.org/x/net/ipv4"
)

func socketOption(conn *net.UDPConn, set func(int) error) error {
	raw, err := conn.SyscallConn()
	if err != nil {
		return err
	}
	var result error
	if err := raw.Control(func(fd uintptr) { result = set(int(fd)) }); err != nil {
		return err
	}
	return result
}

func enableBroadcast(conn *net.UDPConn) error {
	return socketOption(conn, func(fd int) error {
		return syscall.SetsockoptInt(fd, syscall.SOL_SOCKET, syscall.SO_BROADCAST, 1)
	})
}

func configureMulticast(sender *net.UDPConn) error {
	return socketOption(sender, func(fd int) error {
		if err := syscall.SetsockoptInt(fd, syscall.IPPROTO_IP, syscall.IP_MULTICAST_TTL, 1); err != nil {
			return err
		}
		address := sender.LocalAddr().(*net.UDPAddr).AddrPort().Addr().Unmap().As4()
		return syscall.SetsockoptInet4Addr(fd, syscall.IPPROTO_IP, syscall.IP_MULTICAST_IF, address)
	})
}

type packetInfoSocket struct {
	*net.UDPConn
	packet         *ipv4.PacketConn
	interfaceIndex int
}

func newQuerySocket(conn *net.UDPConn, index int) udpSocket {
	packet := ipv4.NewPacketConn(conn)
	if err := packet.SetControlMessage(ipv4.FlagDst|ipv4.FlagInterface, true); err != nil {
		return conn
	}
	return &packetInfoSocket{conn, packet, index}
}

func newSenderSocket(conn *net.UDPConn, index int) udpSocket {
	return &packetInfoSocket{conn, ipv4.NewPacketConn(conn), index}
}

func (s *packetInfoSocket) WriteToUDP(data []byte, destination *net.UDPAddr) (int, error) {
	if destination.AddrPort().Addr().Unmap() == limitedBroadcastIP {
		return s.packet.WriteTo(data, &ipv4.ControlMessage{IfIndex: s.interfaceIndex}, destination)
	}
	return s.UDPConn.WriteToUDP(data, destination)
}

func (s *packetInfoSocket) readQuery(data []byte) (int, *net.UDPAddr, netip.Addr, error) {
	n, control, source, err := s.packet.ReadFrom(data)
	if err != nil {
		return n, nil, netip.Addr{}, err
	}
	addr, _ := source.(*net.UDPAddr)
	if control == nil {
		return n, addr, netip.Addr{}, nil
	}
	destination, _ := netip.AddrFromSlice(control.Dst)
	destination = destination.Unmap()
	if control.IfIndex != 0 && control.IfIndex != s.interfaceIndex &&
		(destination.IsMulticast() || destination == limitedBroadcastIP) {
		return n, nil, destination, nil
	}
	return n, addr, destination, nil
}
