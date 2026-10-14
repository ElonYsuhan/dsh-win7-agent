'use strict'

const { execFile } = require('child_process')

const TITLE = '选择工作区目录'
const OPTIONS = { timeout: 120000, windowsHide: true, encoding: 'utf8' }

function pickNativeFolder() {
  return new Promise((resolve) => {
    const done = (error, stdout, stderr) => {
      const selected = error ? '' : String(stdout || '').trim()
      let canceled = !error && selected === ''
      if (error && process.platform === 'win32') canceled = Number(error.code) === 2
      if (error && process.platform === 'darwin') canceled = /\(-128\)/.test(String(stderr || error.message || ''))
      resolve({ path: selected, canceled })
    }
    if (process.platform === 'darwin') {
      execFile('osascript', ['-e', 'POSIX path of (choose folder with prompt "' + TITLE + '")'], OPTIONS, done)
      return
    }
    if (process.platform === 'win32') {
      // Windows PowerShell 的管道输出默认使用本地代码页；明确 UTF-8 才能保留中文路径。
      const script = '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; ' +
        'Add-Type -AssemblyName System.Windows.Forms; ' +
        '$f = New-Object System.Windows.Forms.FolderBrowserDialog; ' +
        '$f.Description = "' + TITLE + '"; $f.ShowNewFolderButton = $true; ' +
        'if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { ' +
        'Write-Output $f.SelectedPath } else { exit 2 }'
      execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', script], OPTIONS, done)
      return
    }
    // 原生工具不可用时让页面使用服务器目录浏览器；用户取消才结束选择。
    const candidates = [
      ['zenity', ['--file-selection', '--directory', '--title=' + TITLE]],
      ['kdialog', ['--getexistingdirectory', '.', '--title', TITLE]]
    ]
    const pickLinux = (index) => {
      const candidate = candidates[index]
      if (!candidate) { resolve({ path: '', canceled: false }); return }
      execFile(candidate[0], candidate[1], OPTIONS, (error, stdout, stderr) => {
        if (!error) {
          const selected = String(stdout || '').trim()
          resolve({ path: selected, canceled: selected === '' })
          return
        }
        // 两者均以退出码 1 表示取消。显示连接失败也可能返回 1；
        // 只认明确的初始化错误，普通 GTK / 主题警告不能把真取消误判为故障。
        const unavailableDisplay = /cannot open display|could not (?:connect to|open) (?:any )?(?:X )?display|could not load the Qt platform plugin|no Qt platform plugin could be initialized|unable to init server|failed to initialize GTK/i.test(String(stderr || ''))
        if (Number(error.code) === 1 && !error.signal && !error.killed && !unavailableDisplay) {
          resolve({ path: '', canceled: true })
          return
        }
        pickLinux(index + 1)
      })
    }
    pickLinux(0)
  })
}

module.exports = { pickNativeFolder }
