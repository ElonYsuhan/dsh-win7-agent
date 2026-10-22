'use strict'

// SSE is a live view of durable facts, not an unbounded in-memory event log.
// A stalled viewer must not retain all subsequent Agent/terminal output.
const MAX_QUEUED_BYTES = 8 * 1024 * 1024
const MAX_FRAME_BYTES = 32 * 1024 * 1024
function writeEvent(response, frame) {
  if (response.destroyed || response.writableEnded) return false
  const bytes = Buffer.byteLength(frame)
  const queued = response.writableLength || 0
  // Permit one large, bounded finished/history frame on a drained connection.
  // Node owns this buffer; never make an additional JS retry queue.
  if (bytes > MAX_FRAME_BYTES || queued > MAX_QUEUED_BYTES || (queued > 0 && queued + bytes > MAX_QUEUED_BYTES)) {
    response.destroy()
    return false
  }
  try { response.write(frame); return true }
  catch (error) { response.destroy(); return false }
}
module.exports = { writeEvent, MAX_QUEUED_BYTES, MAX_FRAME_BYTES }
