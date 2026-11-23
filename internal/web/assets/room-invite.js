const INVITE_HELP = '请粘贴完整邀请信息，例如 192.168.1.20:45678  房间码 ABCD2345。';

function normalizeInvite({ hostIPv4, hostPort, roomCode }) {
  const address = String(hostIPv4 ?? '').trim();
  const octets = address.split('.');
  if (octets.length !== 4 || octets.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
    throw new Error('邀请中的房主地址无效，请让房主重新复制邀请信息。');
  }
  const parts = octets.map(Number);
  if (!(parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168))) {
    throw new Error('邀请需要使用房主的局域网 IPv4 地址。');
  }
  const port = String(hostPort ?? '').trim();
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('邀请中的端口无效，应为 1–65535。');
  }
  const code = String(roomCode ?? '').trim().toUpperCase();
  if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) {
    throw new Error('邀请中的房间码无效，请复制完整的 8 位房间码。');
  }
  return { hostIPv4: parts.join('.'), hostPort: Number(port), roomCode: code };
}

export function parseRoomInvite(text) {
  const value = String(text ?? '').trim();
  if (value.length > 256) throw new Error(INVITE_HELP);
  // Accept the invitation copied by both current and earlier versions, plus a compact address:port/code form.
  const match = value.match(/^(\d{1,3}(?:\.\d{1,3}){3})\s*[:：]\s*(\d{1,5})(?:\s+房间码\s*[:：]?\s*|\s*\/\s*)([a-z0-9]{8})$/i);
  if (!match) throw new Error(INVITE_HELP);
  return normalizeInvite({ hostIPv4: match[1], hostPort: match[2], roomCode: match[3] });
}

export function formatRoomInvite(details) {
  const { hostIPv4, hostPort, roomCode } = normalizeInvite(details);
  return `${hostIPv4}:${hostPort}  房间码 ${roomCode}`;
}
