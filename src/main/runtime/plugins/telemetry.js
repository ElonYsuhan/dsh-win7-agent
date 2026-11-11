'use strict'

/**
 * runtime/plugins/telemetry.js —— profile 挂载入口（第二阶段）
 *
 * 导出 native cordis plugin 对象；apply 每次被 host.mount 调用时创建独立
 * collector/repository，使多个 PluginHost（各测试场景）互不污染。
 */
const { createTelemetryPlugin } = require('../../telemetry/plugin')

module.exports = createTelemetryPlugin()
