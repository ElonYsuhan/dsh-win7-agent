'use strict'

// Request-local model selection. Connection details stay in trusted settings.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const names = provider => [...new Set([provider.model, ...(Array.isArray(provider.modelList) ? provider.modelList : [])].filter(name => typeof name === 'string' && name.trim()))]
function catalog(settings) {
  const providers = (Array.isArray(settings.models) ? settings.models : []).map(provider => ({ id: provider.id, name: provider.name || provider.id, models: names(provider) })).filter(provider => provider.models.length)
  return { providers, current: { providerId: settings.currentModelId || '', model: settings.model || '' } }
}
function modelSettings(settings, selection) {
  if (selection === undefined || selection === null) return { ...settings }
  if (!object(selection) || Object.keys(selection).some(key => !['providerId', 'model'].includes(key)) || typeof selection.providerId !== 'string' || typeof selection.model !== 'string') throw Error('设计模型选择无效')
  const provider = (Array.isArray(settings.models) ? settings.models : []).find(item => item.id === selection.providerId)
  if (!provider || !names(provider).includes(selection.model)) throw Error('设计模型已不可用，请重新选择已配置的模型')
  return { ...settings, currentModelId: provider.id, baseURL: provider.baseURL, apiKey: provider.apiKey, protocol: provider.protocol, thinking: provider.thinking === true, model: selection.model }
}
module.exports = { catalog, modelSettings }
