const crypto = require('crypto');

function buildServerKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem'
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem'
    }
  });

  const fingerprint = crypto.createHash('sha256').update(publicKey).digest('hex');

  return {
    publicKey,
    privateKey,
    fingerprint
  };
}

function decryptSessionKey(privateKeyPem, encryptedKeyBase64) {
  const encryptedBuffer = Buffer.from(encryptedKeyBase64, 'base64');

  const keyBuffer = crypto.privateDecrypt(
    {
      key: privateKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256'
    },
    encryptedBuffer
  );

  if (keyBuffer.length !== 32) {
    throw new Error('Invalid AES-256 key length after key exchange');
  }

  return keyBuffer;
}

function encryptTextWithAesGcm(text, keyBuffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer, iv);
  const cipherText = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    cipher_text: cipherText.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64')
  };
}

function decryptTextWithAesGcm(payload, keyBuffer) {
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const cipherText = Buffer.from(payload.cipher_text, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer, iv);
  decipher.setAuthTag(tag);

  const plainText = Buffer.concat([decipher.update(cipherText), decipher.final()]);
  return plainText.toString('utf8');
}

module.exports = {
  buildServerKeyPair,
  decryptSessionKey,
  encryptTextWithAesGcm,
  decryptTextWithAesGcm
};
