'use strict'

// Legacy notification/transform API, backed by the same Cordis event registry.
class EventBus {
  constructor(context) { this.context = context }

  listen(context, event, listener) {
    const observe = context.on(event, (payload) => {
      try {
        const result = listener(payload)
        if (result && typeof result.catch === 'function') result.catch((error) => context.logger.error(error))
      } catch (error) { context.logger.error(error) }
    })
    const transform = context.on('legacy:hook:' + event, async (state, next) => {
      const value = await listener(state.value)
      if (value !== undefined) state.value = value
      return next()
    })
    return () => Promise.all([observe(), transform()])
  }

  on(event, listener) { return this.listen(this.context, event, listener) }
  emit(event, payload) { this.context.emit(event, payload) }
  hook(event, payload) {
    // Separate event name preserves the historical on(event) transform contract.
    const state = { value: payload }
    return this.context.waterfall('legacy:hook:' + event, state, () => state.value)
  }
}

module.exports = { EventBus }
