#!/usr/bin/env node
// Test double for scripts/spike-s3.mjs. NOT Claude: it only mimics the stream-json
// shapes the spike reads, so the spike's plumbing can be tested without model usage.
const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('0.0.0-fake (test double)\n');
  process.exit(0);
}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const ri = argv.indexOf('--resume');
const sessionId = ri >= 0 ? argv[ri + 1] : `fake-${process.pid}`;
const partial = argv.includes('--include-partial-messages');
const leak = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].some((k) => k in process.env);
out({ type: 'system', subtype: 'init', session_id: sessionId, apiKeySource: leak ? 'ANTHROPIC_API_KEY' : 'none', permissionMode: 'default', argv });

let queue = [];
let busy = null;
function nextTurn() {
  if (busy || queue.length === 0) return;
  const text = queue.shift();
  out({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: 'working' }] } });
  if (partial) out({ type: 'stream_event', session_id: sessionId, event: { type: 'message_start' } });
  busy = setTimeout(() => {
    busy = null;
    const reply = text.includes('TWO') ? 'TWO' : text.includes('AFTER') ? 'AFTER' : leak ? 'APIKEY-LEAKED' : 'ok';
    out({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: reply });
    nextTurn();
    if (ended && !busy) process.exit(0);
  }, partial ? 400 : 20);
}
let ended = false;
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.type === 'user') { queue.push(msg.message.content); nextTurn(); }
    if (msg.type === 'control_request' && msg.request?.subtype === 'interrupt') {
      if (busy) { clearTimeout(busy); busy = null; }
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } });
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId });
      nextTurn();
    }
  }
});
process.stdin.on('end', () => { ended = true; if (!busy) process.exit(0); });
