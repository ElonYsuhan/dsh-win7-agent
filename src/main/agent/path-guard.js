'use strict'

const fs = require('fs')
const path = require('path')

const not = (value) => value ? false : true

function isInside(root, candidate) {
  const rootAbs = path.resolve(root)
  const candidateAbs = path.resolve(candidate)
  const relative = path.relative(rootAbs, candidateAbs)
  if (relative === '') return true
  if (path.isAbsolute(relative)) return false
  if (relative === '..' || relative.startsWith('..' + path.sep)) return false
  return true
}

function assertInside(root, candidate, label) {
  if (not(root)) {
    throw new Error('WORKSPACE_NOT_SET: choose a local workspace directory first')
  }
  const target = path.resolve(root, candidate || '.')
  if (not(isInside(root, target))) {
    throw new Error('PATH_ESCAPE: ' + (label || 'path') + ' must stay inside the workspace: ' + candidate)
  }
  return target
}

function existingRealPath(root, target) {
  const absolute = assertInside(root, target, 'path')
  try {
    const rootReal = fs.realpathSync.native(path.resolve(root))
    const real = fs.realpathSync.native(absolute)
    if (not(isInside(rootReal, real))) {
      throw new Error('PATH_ESCAPE: symlink points outside the workspace: ' + target)
    }
    return real
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error
    return absolute
  }
}

function ensureParentInside(root, target) {
  const absolute = assertInside(root, target, 'path')
  let parent = path.dirname(absolute)
  while (not(fs.existsSync(parent)) && parent !== path.dirname(parent)) {
    parent = path.dirname(parent)
  }
  const rootReal = fs.realpathSync.native(path.resolve(root))
  const parentReal = fs.realpathSync.native(parent)
  if (not(isInside(rootReal, parentReal))) {
    throw new Error('PATH_ESCAPE: parent directory is outside the workspace: ' + target)
  }
  return absolute
}

function relativeDisplay(root, absolute) {
  let rootPath = path.resolve(root)
  let targetPath = path.resolve(absolute)
  try { rootPath = fs.realpathSync.native(rootPath) } catch (error) {}
  try { targetPath = fs.realpathSync.native(targetPath) } catch (error) {}
  const rel = path.relative(rootPath, targetPath)
  return rel === '' ? '.' : rel.split(path.sep).join('/')
}

module.exports = { isInside, assertInside, existingRealPath, ensureParentInside, relativeDisplay }
