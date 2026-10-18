'use strict'

// Shared presentation adapter for native single-selects. The original select
// remains the value/form contract; no separate settings state is introduced.
;(function () {
  if (typeof document === 'undefined') return
  const controls = new WeakMap()
  let opened = null
  function close(restore) {
    if (!opened) return
    const item = opened; opened = null
    item.menu.classList.add('hidden'); item.wrapper.classList.remove('open')
    item.trigger.setAttribute('aria-expanded', 'false')
    if (restore) item.trigger.focus()
  }
  function refresh(select) {
    const item = controls.get(select)
    if (!item) return
    const option = select.selectedOptions[0]
    item.label.textContent = option ? option.textContent : '请选择'
    item.trigger.disabled = select.disabled
    item.trigger.setAttribute('aria-label', item.name + '：' + item.label.textContent)
    if (select.getAttribute('aria-describedby')) item.trigger.setAttribute('aria-describedby', select.getAttribute('aria-describedby'))
  }
  function open(item) {
    close(false); refresh(item.select); item.menu.textContent = ''; item.wrapper.classList.remove('select-open-up'); item.menu.style.maxHeight = ''
    for (const option of item.select.options) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'dropdown-item'
      b.setAttribute('role', 'option'); b.setAttribute('aria-selected', String(option.selected)); b.tabIndex = -1
      b.disabled = option.disabled || Boolean(option.parentElement.disabled)
      b.textContent = option.textContent
      if (option.selected) { b.classList.add('active'); b.textContent += '  ✓' }
      b.addEventListener('click', () => {
        item.select.value = option.value
        item.select.dispatchEvent(new Event('input', { bubbles: true }))
        item.select.dispatchEvent(new Event('change', { bubbles: true }))
        refresh(item.select); close(true)
      })
      item.menu.appendChild(b)
    }
    item.wrapper.classList.add('open'); item.menu.classList.remove('hidden'); item.trigger.setAttribute('aria-expanded', 'true'); opened = item
    const available = Array.from(item.menu.children).filter(b => !b.disabled)
    const chosen = available.find(b => b.getAttribute('aria-selected') === 'true') || available[0]
    if (chosen) chosen.focus()
    const box = item.menu.getBoundingClientRect(), triggerBox = item.trigger.getBoundingClientRect()
    let top = 8, bottom = window.innerHeight - 8
    for (let parent = item.wrapper.parentElement; parent; parent = parent.parentElement) {
      if (/(auto|scroll|hidden)/.test(getComputedStyle(parent).overflowY)) { const bounds = parent.getBoundingClientRect(); top = Math.max(top, bounds.top + 6); bottom = Math.min(bottom, bounds.bottom - 6) }
    }
    const below = bottom - triggerBox.bottom - 4, above = triggerBox.top - top - 4, up = below < box.height && above > below
    item.wrapper.classList.toggle('select-open-up', up)
    item.menu.style.maxHeight = Math.max(40, Math.min(220, up ? above : below)) + 'px'
  }
  function enhance(select) {
    if (controls.has(select) || select.multiple || select.size > 1) return
    const wrapper = document.createElement('div'); wrapper.className = 'dropdown select-control'
    const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'dropdown-trigger select-trigger'
    const label = document.createElement('span'); label.className = 'select-label'
    const arrow = document.createElement('span'); arrow.className = 'dropdown-chevron'; arrow.textContent = '⌄'; arrow.setAttribute('aria-hidden', 'true')
    const menu = document.createElement('div'); menu.className = 'dropdown-menu hidden'; menu.setAttribute('role', 'listbox')
    menu.id = (select.id || 'select-' + document.querySelectorAll('.select-control').length) + '-options'
    trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-controls', menu.id); trigger.setAttribute('aria-expanded', 'false')
    const name = select.getAttribute('aria-label') || Array.from(select.labels || []).map(n => n.querySelector('.task-field-label') ? n.querySelector('.task-field-label').textContent : n.textContent).join(' ').trim() || '选项'
    menu.setAttribute('aria-label', name)
    const item = { select, wrapper, trigger, label, menu, name }; controls.set(select, item)
    select.parentNode.insertBefore(wrapper, select); wrapper.append(select, trigger, menu); trigger.append(label, arrow)
    select.classList.add('agent-native-select'); select.tabIndex = -1; select.setAttribute('aria-hidden', 'true')
    select.addEventListener('change', () => refresh(select))
    select.addEventListener('invalid', event => { event.preventDefault(); trigger.focus(); trigger.setAttribute('aria-invalid', 'true') })
    trigger.addEventListener('click', () => opened === item ? close(false) : open(item))
    trigger.addEventListener('keydown', event => { if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); open(item); if (event.key === 'End' || event.key === 'ArrowUp') { const buttons = Array.from(menu.children).filter(b => !b.disabled); if (buttons.length) buttons[buttons.length - 1].focus() } } })
    menu.addEventListener('keydown', event => {
      const buttons = Array.from(menu.children).filter(b => !b.disabled), index = buttons.indexOf(document.activeElement)
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true) }
      else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); if (buttons[index]) buttons[index].click() }
      else if (event.key === 'Tab') close(false)
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        if (buttons[next]) buttons[next].focus()
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) { const target = buttons.find(b => b.textContent.trim().toLowerCase().startsWith(event.key.toLowerCase())); if (target) target.focus() }
    })
    refresh(select)
  }
  function scan(node) { if (node.nodeType !== 1) return; if (node.matches('select')) enhance(node); for (const select of node.querySelectorAll('select')) enhance(select) }
  document.addEventListener('pointerdown', event => { if (opened && !opened.wrapper.contains(event.target)) close(false) })
  document.addEventListener('focusin', event => { if (opened && !opened.wrapper.contains(event.target)) close(false) })
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && opened) { event.preventDefault(); event.stopPropagation(); close(true) } }, true)
  const observer = new MutationObserver(records => { for (const r of records) { if (r.type === 'attributes' && r.target.matches('select')) refresh(r.target); for (const node of r.addedNodes) scan(node) } })
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] })
  scan(document.body)
  window.agentSelect = { enhance, refresh, close }
})()
