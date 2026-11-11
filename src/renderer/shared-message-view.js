'use strict'

// Presentation only. No transport, session state, platform APIs or tool execution.
;(function () {
  function setContent(body, text, markdown) {
    const value = String(text === undefined || text === null ? '' : text)
    if (markdown && typeof window.renderMarkdown === 'function') {
      body.dataset.raw = value
      body.innerHTML = window.renderMarkdown(value)
      body.__paintedRaw = value
    } else body.textContent = value
  }

  function toolOutput(value) {
    const text = String(value === undefined || value === null ? '' : value)
    const output = document.createElement('details')
    output.className = 'tl-detail'
    const summary = document.createElement('summary')
    summary.textContent = '输出 · ' + text.split('\n').length + ' 行'
    const pre = document.createElement('pre')
    pre.className = 'tl-output'
    pre.textContent = text
    output.appendChild(summary)
    output.appendChild(pre)
    return output
  }

  window.agentMessageView = Object.freeze({ setContent, toolOutput })
})()
