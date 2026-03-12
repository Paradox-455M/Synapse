// SSE stream parser for ChatGPT's delta format.
// Reference copy — inlined directly into content-main.js (script-tag injection
// does not support ES module imports, so this file cannot be imported).

// ChatGPT SSE delta formats observed in production:
//   event: delta
//   data: {"v":[{"p":"/message/content/parts/0","o":"append","v":"word"}]}
//
//   event: delta
//   data: {"p":"/message/content/parts/0","o":"append","v":"Since you"}

/**
 * parseSSEStream — consume a ReadableStream of SSE bytes.
 *
 * @param {ReadableStream} stream  — monitor copy from response.body.tee()
 * @param {(chunk: string) => void} onText — called for each extracted text delta
 * @param {(fullText: string) => void} onDone — called when [DONE] seen or stream ends
 */
export function parseSSEStream(stream, onText, onDone) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let done = false;

  function processBlock(block) {
    if (done) return;
    const lines = block.split('\n');
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') {
        done = true;
        onDone(fullText);
        return;
      }
      try {
        const parsed = JSON.parse(data);
        let delta = null;
        // Format A: { v: [{p: "...", o: "append", v: "text"}, ...] }
        if (Array.isArray(parsed.v)) {
          const item = parsed.v.find(
            (x) => x.o === 'append' && typeof x.p === 'string' && x.p.includes('content/parts')
          );
          if (item) delta = item.v;
        }
        // Format B: { p: "...", o: "append", v: "text" }
        if (delta === null && parsed.o === 'append' &&
            typeof parsed.p === 'string' && parsed.p.includes('content/parts')) {
          delta = parsed.v;
        }
        if (typeof delta === 'string' && delta.length > 0) {
          fullText += delta;
          onText(delta);
        }
      } catch (_) { /* non-JSON line, skip */ }
    }
  }

  function pump() {
    reader.read().then(({ done: streamDone, value }) => {
      if (value) {
        buffer += decoder.decode(value, { stream: true });
      }

      // Split on double-newline (SSE block separator)
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? ''; // keep the trailing incomplete block

      for (const block of blocks) {
        if (done) break;
        if (block.trim()) processBlock(block);
      }

      if (done) return;

      if (streamDone) {
        // Flush any remaining buffer content
        if (buffer.trim()) processBlock(buffer);
        if (!done) onDone(fullText);
        return;
      }

      pump();
    }).catch(() => {
      if (!done) onDone(fullText);
    });
  }

  pump();
}
