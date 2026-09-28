(() => {
  // The guest has only framed stdin/stdout. The host treats every frame as untrusted.
  const read = globalThis.Javy.IO.readSync;
  const write = globalThis.Javy.IO.writeSync;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function receive() {
    const bytes = [];
    const byte = new Uint8Array(1);
    while (read(0, byte)) {
      if (byte[0] === 10)
        return JSON.parse(decoder.decode(new Uint8Array(bytes)));
      if (bytes.length >= 262144) throw new Error('Input exceeds limit');
      bytes.push(byte[0]);
    }
    throw new Error('Input ended');
  }

  function send(value) {
    const bytes = encoder.encode(JSON.stringify(value) + '\n');
    let offset = 0;
    while (offset < bytes.length) offset += write(1, bytes.subarray(offset));
  }

  const message = receive();
  Object.defineProperty(globalThis, 'Date', {
    value: undefined,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(Math, 'random', {
    value() {
      throw new Error('Randomness is unavailable');
    },
    writable: false,
    configurable: false,
  });
  const luma = Object.freeze({
    now: message.now,
    request(grant) {
      send({ type: 'request', grant });
      const reply = receive();
      if (reply.type !== 'response') throw new Error('Capability unavailable');

      return reply.value;
    },
  });
  // Only structured, filtered diagnostics leave the guest. User messages may contain input data.
  globalThis.console = Object.freeze({
    log() {
      return undefined;
    },
    info() {
      return undefined;
    },
    warn() {
      return undefined;
    },
    error() {
      return undefined;
    },
  });
  globalThis.Javy = undefined;
  try {
    const invoke = new Function(
      'input',
      'luma',
      '"use strict";\n' + message.code + '\nreturn main(input, luma);',
    );
    const value = invoke(message.input, luma);
    if (value && typeof value.then === 'function')
      throw new Error('Async entrypoints are unsupported');
    send({ type: 'result', value });
  } catch {
    send({ type: 'error', code: 'code_error' });
  }
})();
