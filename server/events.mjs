// One SSE stream for the whole page. emit(event, data) sends a named event to
// every open page. The last value of each event name is replayed to a page that
// connects later, so emit whole state, not deltas.
const clients = new Set();
const latest = new Map();

export function emit(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  latest.set(event, frame);
  for (const res of clients) res.write(frame);
}

export function serveEvents(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
  for (const frame of latest.values()) res.write(frame);
  clients.add(res);
  req.on('close', () => clients.delete(res));
}
