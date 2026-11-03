export function bindLocalConnectionLifecycle(client, media, onDisconnected) {
  client.addEventListener('disconnected', () => {
    if (client.explicitlyLeaving) return;
    client.reconnectWanted = false;
    client.room = null;
    client.peerId = '';
    client.resumeToken = '';
    client.joinDetails = null;
    Promise.resolve(media.closeAll())
      .catch(() => {})
      .finally(() => onDisconnected());
  });
}
