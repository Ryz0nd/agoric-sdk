// FIXME: vat-safe sha256
import crypto from 'node:crypto';

// ack: https://stackoverflow.com/a/40031979/7963
function buf2hex(buffer) {
  // buffer is an ArrayBuffer
  return [...new Uint8Array(buffer)]
    .map(x => x.toString(16).padStart(2, '0'))
    .join('');
}

const te = new TextEncoder();

// https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest
const sha256 = txt =>
  crypto.subtle.digest('SHA-256', te.encode(txt)).then(buf => buf2hex(buf));

export const denomHash = async ({
  portId = 'transfer',
  channelId = /** @type {string | undefined} */ (undefined),
  path = `${portId}/${channelId}`,
  denom,
}) => {
  return sha256(`${path}/${denom}`).then(s => s.toUpperCase());
};
