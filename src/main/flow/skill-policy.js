'use strict'

// Global skill switches are independent of IO, platform and runtime.
function enabled(item, disabledIds) {
  return Boolean(item) && !disabledIds.has(item.id)
}
module.exports = { enabled }
