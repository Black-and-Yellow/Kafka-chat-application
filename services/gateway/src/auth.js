const jwt = require('jsonwebtoken');

function extractToken(request) {
  const authHeader = request.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }

  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    return url.searchParams.get('token');
  } catch {
    return null;
  }
}

function verifyToken(token, secret) {
  if (!token) {
    throw new Error('Missing authentication token');
  }

  const payload = jwt.verify(token, secret);
  if (!payload || !payload.user_id) {
    throw new Error('JWT payload must include user_id');
  }

  return {
    userId: String(payload.user_id),
    displayName: payload.name ? String(payload.name) : String(payload.user_id)
  };
}

module.exports = {
  extractToken,
  verifyToken
};
