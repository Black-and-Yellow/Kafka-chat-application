const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function arrayBufferToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

export function base64ToUint8Array(base64Value) {
  const binary = atob(base64Value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function pemToArrayBuffer(pem) {
  const body = pem
    .replace('-----BEGIN PUBLIC KEY-----', '')
    .replace('-----END PUBLIC KEY-----', '')
    .replace(/\s+/g, '');
  return base64ToUint8Array(body).buffer;
}

export async function importServerPublicKey(publicKeyPem) {
  return crypto.subtle.importKey(
    'spki',
    pemToArrayBuffer(publicKeyPem),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt']
  );
}

export async function encryptMessageTransport(plainText, aesKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    textEncoder.encode(plainText)
  );

  const encryptedBytes = new Uint8Array(encryptedBuffer);
  const tag = encryptedBytes.slice(encryptedBytes.length - 16);
  const cipherText = encryptedBytes.slice(0, encryptedBytes.length - 16);

  return {
    cipher_text: arrayBufferToBase64(cipherText.buffer),
    iv: arrayBufferToBase64(iv.buffer),
    tag: arrayBufferToBase64(tag.buffer),
  };
}

export async function decryptMessageTransport(encryptedPayload, aesKey) {
  const iv = base64ToUint8Array(encryptedPayload.iv);
  const tag = base64ToUint8Array(encryptedPayload.tag);
  const cipherText = base64ToUint8Array(encryptedPayload.cipher_text);
  const combined = new Uint8Array(cipherText.length + tag.length);

  combined.set(cipherText, 0);
  combined.set(tag, cipherText.length);

  const plainBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    combined
  );

  return textDecoder.decode(plainBuffer);
}
