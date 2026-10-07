'use strict'

const not = (value) => value ? false : true

class EventBus {
  constructor() {
    this.listeners = new Map()
    this.disposers = []
  }

  on(event, listener) {
    if (not(this.listeners.has(event))) this.listeners.set(event, [])
    const list = this.listeners.get(event)
    list.push(listener)
    return () => {
      const index = list.indexOf(listener)
      if (index >= 0) list.splice(index, 1)
    }
  }

  emit(event, payload) {
    const list = this.listeners.get(event) || []
    for (const listener of list.slice()) {
      try {
        listener(payload)
      } catch (error) {
        console.error('[plugins] event failed: ' + event, error)
      }
    }
  }

  async hook(event, payload) {
    let current = payload
    const list = this.listeners.get(event) || []
    for (const listener of list.slice()) {
      try {
        const next = await listener(current)
        if (next !== undefined) current = next
      } catch (error) {
        console.error('[plugins] hook failed: ' + event, error)
      }
    }
    return current
  }

  clear() {
    this.listeners.clear()
  }
}

module.exports = { EventBus }
