/** Decodes text files: UTF-8 with or without a byte-order mark, UTF-16, else Windows-1252. */
export function decodeText(bytes: Uint8Array) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Older German exports are often Windows-1252, a superset of Latin-1.
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** Whether decoded text looks like binary content: many control characters other than whitespace. */
export function looksBinary(text: string) {
  const sample = text.slice(0, 4096);
  if (!sample) return false;
  let control = 0;
  for (let index = 0; index < sample.length; index++) {
    const code = sample.charCodeAt(index);
    if (code < 32 && code !== 9 && code !== 10 && code !== 12 && code !== 13)
      control++;
  }

  return control / sample.length > 0.05;
}

/** Normalizes line breaks so offsets are the same on every platform. */
export const normalizeLines = (text: string) => text.replace(/\r\n?/g, '\n');
