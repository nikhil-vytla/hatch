// Trusted entry module: never put candidate source in the initial import graph.
// Deno's initial graph is exempt from read permissions; runtime imports are not.
const chunks = [];
for await (const part of Deno.stdin.readable) chunks.push(part);
const count = chunks.reduce((n, c) => n + c.length, 0);
const data = new Uint8Array(count);
let offset = 0;
for (const part of chunks) { data.set(part, offset); offset += part.length; }
const input = JSON.parse(new TextDecoder().decode(data));
const step = new Function('"use strict";\n' + input.source + '\nreturn step;')();
const output = await step(input.view, input.state, input.result, input.handles);
console.log(JSON.stringify(output));
