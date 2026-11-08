'use strict'

// Adapts the authoritative conversation to the optional declarative renderer.
// The temporary live notifications below are only a visual preview: they are
// discarded on session changes and reconciled with the finished snapshot.
;(function () {
  const MAX_LIVE_NOTIFICATIONS = 256
  const UNAVAILABLE = '此界面暂不可用或版本不受支持。'

  function createGenerativeUIChat(options) {
    const slots = new Set()
    const live = []
    let owner = ''
    let loading = null
    let scheduled = false
    let overflowSlot = null
    let interactionSnapshot = null
    let reading = null
    function interaction(snapshot) {
      if (!snapshot || snapshot.version !== 1 || snapshot.sessionId !== owner || owner !== options.sessionId() || !Number.isSafeInteger(snapshot.sequence)) return
      if (interactionSnapshot && snapshot.sequence < interactionSnapshot.sequence) return
      interactionSnapshot = snapshot
      schedule()
    }
    const interactionHost = options.interactionHost ? {
      read(request) {
        if (reading && reading.sessionId === request.sessionId && reading.surfaceId === request.surfaceId) return reading.promise
        const ticket = { sessionId: request.sessionId, surfaceId: request.surfaceId, promise: null }
        ticket.promise = Promise.resolve().then(() => options.interactionHost.read(request)).then(value => { interaction(value); return value }).finally(() => { if (reading === ticket) reading = null })
        reading = ticket
        return ticket.promise
      },
      change: request => Promise.resolve(options.interactionHost.change(request)).then(value => { interaction(value); return value }),
      dispatch: request => options.interactionHost.dispatch(request, engine().capabilities()),
      confirm: message => options.interactionHost.confirm(message),
      requestId: () => options.interactionHost.requestId(),
      onRun: (sessionId, phase) => { if (typeof options.interactionHost.onRun === 'function') options.interactionHost.onRun(sessionId, phase) }
    } : undefined

    function engine() {
      const value = window.AgentGenerativeUI
      return value && typeof value.projectMessages === 'function' && typeof value.mountSurface === 'function' ? value : null
    }
    function resource(tag, attributes) {
      return new Promise((resolve, reject) => {
        const node = document.createElement(tag)
        for (const name of Object.keys(attributes)) node[name] = attributes[name]
        node.onload = () => resolve()
        node.onerror = () => reject(new Error('GENERATIVE_UI_RESOURCE_UNAVAILABLE'))
        document.head.appendChild(node)
      })
    }
    function ensureResources() {
      if (engine()) return Promise.resolve(engine())
      if (!loading) {
        // Fixed local resources only; no model-supplied paths, dynamic code or
        // network dependency. The build keeps third-party code in vendor/.
        loading = resource('link', { rel: 'stylesheet', href: 'generative-ui/agent-generative-ui.css' })
          .then(() => resource('script', { src: 'vendor/generative-ui/agent-ui-vendor.js' }))
          .then(() => resource('script', { src: 'generative-ui/agent-generative-ui.js' }))
          .then(() => {
            if (!engine()) throw new Error('GENERATIVE_UI_RENDERER_UNAVAILABLE')
            return engine()
          })
      }
      return loading
    }
    function unmount(slot) {
      if (slot.mounted) {
        try { slot.mounted.dispose() } catch (_) {}
        slot.mounted = null
      }
      slot.surface = null
    }
    function removeSlot(slot) {
      unmount(slot)
      slots.delete(slot)
      slot.group.slots.delete(slot)
    }
    function syncGroups() {
      const groups = new Set()
      for (const slot of slots) groups.add(slot.group)
      for (const group of groups) {
        group.wrapper.hidden = !group.hasText && Array.from(group.slots).every(slot => slot.host.hidden)
      }
    }
    function showUnavailable(slot, text) {
      unmount(slot)
      slot.host.hidden = false
      slot.host.setAttribute('role', 'status')
      slot.host.textContent = text || UNAVAILABLE
    }
    function applyProjection(renderer) {
      if (!owner || owner !== options.sessionId()) return
      const messages = options.messages()
      if (!Array.isArray(messages)) return
      if (overflowSlot) {
        for (const slot of slots) {
          if (slot === overflowSlot) showUnavailable(slot, '界面更新较多，任务结束后显示最终结果。')
          else { unmount(slot); slot.host.hidden = true }
        }
        syncGroups()
        return
      }
      let projected
      try { projected = renderer.projectMessages(owner, messages.concat(live)) } catch (_) {
        for (const slot of slots) showUnavailable(slot)
        syncGroups()
        return
      }
      for (const slot of slots) {
        if (slot.sessionId !== owner) {
          unmount(slot)
          slot.host.hidden = true
          continue
        }
        let messageIndex = slot.messageIndex
        if (slot.liveIndex !== null) messageIndex = messages.length + slot.liveIndex
        else if (messages[messageIndex] !== slot.message) messageIndex = messages.indexOf(slot.message)
        const message = messageIndex < 0 ? null : projected[messageIndex]
        const part = message && message.parts[slot.partIndex]
        if (!part || part.kind === 'superseded') {
          unmount(slot)
          slot.host.textContent = ''
          slot.host.hidden = true
        } else if (part.kind !== 'ui') {
          showUnavailable(slot)
        } else {
          slot.host.hidden = false
          slot.host.removeAttribute('role')
          const props = { sessionId: owner, surface: part.surface, theme: options.theme(), interactionHost, snapshot: interactionSnapshot }
          try {
            if (!slot.mounted || slot.surface !== part.surface) {
              unmount(slot)
              slot.host.textContent = ''
              slot.mounted = renderer.mountSurface(slot.host, props)
              slot.surface = part.surface
            } else {
              slot.mounted.update(props)
            }
          } catch (_) { showUnavailable(slot) }
        }
      }
      syncGroups()
    }
    function schedule() {
      if (scheduled || !slots.size) return
      scheduled = true
      Promise.resolve().then(() => ensureResources()).then(renderer => {
        scheduled = false
        applyProjection(renderer)
      }, () => {
        scheduled = false
        if (owner !== options.sessionId()) return
        for (const slot of slots) showUnavailable(slot, '交互界面资源不可用。')
        syncGroups()
      })
    }
    function group(wrapper, hasText) {
      return { wrapper, hasText: Boolean(hasText), slots: new Set() }
    }
    function addSlot(host, groupInfo, sessionId, messages, messageIndex, partIndex, liveIndex) {
      if (!owner || owner !== sessionId || owner !== options.sessionId()) return
      const slot = { host, group: groupInfo, sessionId, message: messages[messageIndex], messageIndex, partIndex, liveIndex: liveIndex === undefined ? null : liveIndex, mounted: null, surface: null }
      groupInfo.slots.add(slot)
      slots.add(slot)
      host.setAttribute('role', 'status')
      host.textContent = '正在加载交互界面…'
      schedule()
      return slot
    }
    function notification(event, createHost) {
      const messages = options.messages()
      if (!event || !owner || event.sessionId !== owner || owner !== options.sessionId() || !Array.isArray(messages)) return false
      if (event.snapshot) interaction(event.snapshot)
      if (live.length >= MAX_LIVE_NOTIFICATIONS) {
        if (!overflowSlot) {
          const created = createHost()
          overflowSlot = addSlot(created.host, group(created.wrapper, false), owner, messages, 0, 0, -1)
          schedule()
        }
        return false
      }
      const index = live.length
      live.push({ role: 'assistant', content: [{ type: 'ui', toolCallId: event.toolCallId, surface: event.surface }] })
      const created = createHost()
      addSlot(created.host, group(created.wrapper, false), owner, messages, 0, 0, index)
      schedule()
      return true
    }
    function disposeWithin(root) {
      if (!root || typeof root.contains !== 'function') return
      for (const slot of Array.from(slots)) if (root === slot.host || root.contains(slot.host)) removeSlot(slot)
    }
    function reset(sessionId) {
      for (const slot of Array.from(slots)) removeSlot(slot)
      live.length = 0
      overflowSlot = null
      interactionSnapshot = null
      reading = null
      owner = sessionId || ''
    }
    function themeChanged() { if (engine()) applyProjection(engine()) }
    return Object.freeze({ capabilities: () => ensureResources().then(renderer => renderer.capabilities()).catch(() => null), group, addSlot, notification, interaction, disposeWithin, reset, themeChanged, hasLive: () => live.length > 0 })
  }
  window.createGenerativeUIChat = createGenerativeUIChat
})()
