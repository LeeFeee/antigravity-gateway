'use strict';

// Installed public desktop client identity: current Gemini 1.144.4.1467
// binary contains this client ID; Google token exchange is verified separately.
// This embedded desktop client value is not an account credential.
const CLIENT_ID = "839509190550-l232s7lupkp6f57818eshd7u4sl4920h.apps.googleusercontent.com";
const CLIENT_SECRET_BASE64 = "R09DU1BYLWNkZWIwR0NrVE1MWUZURWhLQTMxcGhGQ0JSc24=";

// flexible-api matches the observed native authorization scope. Identity
// scopes are needed to bind the dashboard account to Google's verified subject.
// Google returns expanded first-party grants; requested scopes are not a claim
// about the narrower scope of the resulting token. Do not request legacy extras.
const GEMINI_OAUTH_SCOPES = Object.freeze(['openid', 'email', 'profile',
  'https://www.googleapis.com/auth/flexible-api']);
function geminiOAuthClient() {
  return { clientId: CLIENT_ID, clientSecret: Buffer.from(CLIENT_SECRET_BASE64, 'base64').toString('utf8') };
}

module.exports = { GEMINI_OAUTH_SCOPES, geminiOAuthClient };
