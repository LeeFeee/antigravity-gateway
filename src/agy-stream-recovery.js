'use strict';

// Raw user-role message captured from agy 1.4.2 after actual response-stream
// interruption. This is not a caller prompt and has no USER_REQUEST wrapper.
const STREAM_INTERRUPTED = 'Error: The stream was interrupted. Please continue the task you were working on.';
function streamErrorContent() { return { role: 'user', parts: [{ text: STREAM_INTERRUPTED }] }; }
function isStreamError(content) {
  return content?.role === 'user' && Object.keys(content).length === 2
    && Array.isArray(content.parts) && content.parts.length === 1
    && Object.keys(content.parts[0] || {}).length === 1 && content.parts[0].text === STREAM_INTERRUPTED;
}
function validStreamContents(contents) {
  // A separate, bounded private projection, not permission for ordinary image
  // or finish projections to inject arbitrary user history.
  return Array.isArray(contents) && contents.length > 0 && contents.length <= 64
    // A terminal ninth failure can follow eight HTTP errors: agy retains its
    // real partial model answer without adding any continuation user message.
    && contents.every(c => isStreamError(c) || c?.role === 'model' && Array.isArray(c.parts) && c.parts.length > 0);
}

function capturedCancellationPair(contents, index) {
  const exact = (content, role, text) => content?.role === role && content.parts?.length === 1
    && Object.keys(content.parts[0]).length === 1 && content.parts[0].text === text;
  return exact(contents[index], 'user', '[Request interrupted by user]')
    && exact(contents[index + 1], 'model', 'No response requested.')
    && contents[index + 2]?.role === 'user';
}

module.exports = { STREAM_INTERRUPTED, streamErrorContent, isStreamError, validStreamContents, capturedCancellationPair };
