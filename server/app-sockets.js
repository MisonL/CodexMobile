export const sockets = new Set();

export function broadcast(payload) {
  const serialized = JSON.stringify(payload);
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) {
      socket.send(serialized);
    }
  }
}

export function addBrowserSocket(ws) {
  sockets.add(ws);
  ws.on('close', () => sockets.delete(ws));
}
