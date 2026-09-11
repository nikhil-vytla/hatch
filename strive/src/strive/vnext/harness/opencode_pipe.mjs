// OpenCode 1.18.30 custom AI SDK provider. No network, credentials or tools.
// The outer gateway authenticates the single effect token and settles usage.
import { readSync, writeSync } from 'node:fs';

let used = false;
function line(fd) {
  const bytes = [];
  const one = Buffer.alloc(1);
  while (bytes.length <= 1048576) {
    if (readSync(fd, one, 0, 1, null) !== 1) throw new Error('gateway closed');
    if (one[0] === 10) return JSON.parse(Buffer.from(bytes).toString());
    bytes.push(one[0]);
  }
  throw new Error('gateway response exceeds quota');
}

export function createStrive() {
  function languageModel(modelId) {
    return {
      specificationVersion: 'v3', provider: 'strive', modelId, supportedUrls: {},
      async doStream(options) {
        if (used || modelId !== 'gpt-5.6-luna') throw new Error('one pinned generation per session');
        if (options.tools?.length) throw new Error('native tools forbidden');
        const input = options.prompt.map(message => {
          if (!['system', 'user', 'assistant'].includes(message.role)) throw new Error('unsupported role');
          const parts = typeof message.content === 'string' ? [{type:'text', text:message.content}] : message.content;
          if (parts.some(part => part.type !== 'text')) throw new Error('literal text only');
          return {role:message.role, content:parts.map(part => part.text).join('\n')};
        });
        const raw = JSON.stringify({model:modelId, input, max_output_tokens:Number(process.env.STRIVE_OUTPUT_TOKENS),
          service_tier:'default', store:false, prompt_cache_options:{mode:'explicit'}, reasoning:{effort:'low'}});
        used = true;
        writeSync(1, JSON.stringify({gateway_request:raw, token:process.env.STRIVE_GATEWAY_TOKEN, path:'/generation'}) + '\n');
        const reply = line(Number(process.env.STRIVE_REPLY_FD));
        if (reply.status !== 200) throw new Error('gateway denied generation');
        const response = JSON.parse(reply.body);
        const messages = response.output?.filter(item => item.type !== 'reasoning');
        if (response.status !== 'completed' || messages?.length !== 1 || messages[0].type !== 'message')
          throw new Error('incomplete text generation');
        if (messages[0].content.some(part => part.type !== 'output_text')) throw new Error('unsupported output');
        const text = messages[0].content.map(part => part.text).join('');
        return {stream:new ReadableStream({start(controller) {
          controller.enqueue({type:'stream-start', warnings:[]});
          controller.enqueue({type:'text-start', id:'answer'});
          controller.enqueue({type:'text-delta', id:'answer', delta:text});
          controller.enqueue({type:'text-end', id:'answer'});
          controller.enqueue({type:'finish', finishReason:{unified:'stop', raw:'stop'}, usage:{inputTokens:{total:response.usage.input_tokens, noCache:response.usage.input_tokens, cacheRead:0, cacheWrite:0}, outputTokens:{total:response.usage.output_tokens, text:response.usage.output_tokens, reasoning:0}}});
          controller.close();
        }})};
      },
      async doGenerate() { throw new Error('auxiliary generation forbidden'); }
    };
  }
  return {languageModel};
}
