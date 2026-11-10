#!/usr/bin/env node
// Started by the browser. Reads framed JSON on stdin, answers on stdout.
let buffer = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  // One chunk can hold half a message or several: loop until a whole one is not there.
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (buffer.length < 4 + length) break;
    const message = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
    buffer = buffer.subarray(4 + length);
    console.error('host got', message); // stderr: safe
    send({ echo: message.text, pid: process.pid });
  }
});

// The browser closes stdin when the port disconnects: exit then.
process.stdin.on('end', () => process.exit(0));
