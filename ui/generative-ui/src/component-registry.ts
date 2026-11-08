import type { ComponentKind } from './types'

// Only schema-known names are registrable. Components come from trusted host
// code, never a path, URL, script, or component implementation in model data.
export const COMPONENT_KINDS: readonly ComponentKind[] = Object.freeze(['column', 'row', 'form', 'input', 'checkbox', 'text', 'slider', 'chart', 'button', 'table', 'filter', 'progress', 'flow', 'map', 'visual'] as ComponentKind[])
export type BuiltInComponents<T> = Readonly<Record<ComponentKind, T>>
export interface ComponentRegistry<T> { resolve(kind: unknown): T }
export interface ComponentRegistryBuilder<T> {
  register(kind: unknown, component: T): void
  replace(kind: unknown, component: T): void
  build(): ComponentRegistry<T>
}
const registries = new WeakSet<object>()
function fail(reason: string): never { throw new Error('GENERATIVE_UI_REGISTRY_INVALID: ' + reason) }
function knownKind(kind: unknown): asserts kind is ComponentKind {
  if (typeof kind !== 'string' || !COMPONENT_KINDS.includes(kind as ComponentKind)) fail('unsupported component')
}
function trusted<T>(component: T): void {
  if (!component || (typeof component !== 'object' && typeof component !== 'function')) fail('untrusted component')
}
export function assertComponentRegistry<T>(registry: ComponentRegistry<T>): void {
  if (!registry || !registries.has(registry)) fail('registry must be created by trusted assembly')
}
// Registration is mutable only during trusted assembly. build() snapshots and
// seals it; model output can select only an already-validated component kind.
export function createComponentRegistryBuilder<T>(): ComponentRegistryBuilder<T> {
  const entries = Object.create(null) as Partial<Record<ComponentKind, T>>
  let sealed = false
  function put(kind: unknown, component: T, replace: boolean): void {
    if (sealed) fail('builder is sealed')
    knownKind(kind); trusted(component)
    const exists = Object.prototype.hasOwnProperty.call(entries, kind)
    if (exists && !replace) fail('duplicate component')
    if (!exists && replace) fail('missing component')
    entries[kind] = component
  }
  return Object.freeze({
    register(kind: unknown, component: T): void { put(kind, component, false) },
    replace(kind: unknown, component: T): void { put(kind, component, true) },
    build(): ComponentRegistry<T> {
      if (sealed) fail('builder is sealed')
      if (COMPONENT_KINDS.some(kind => !Object.prototype.hasOwnProperty.call(entries, kind))) fail('built-in kinds')
      sealed = true
      const snapshot = Object.freeze({ ...entries }) as BuiltInComponents<T>
      const registry = Object.freeze({
        resolve(kind: unknown): T { knownKind(kind); return snapshot[kind] }
      })
      registries.add(registry)
      return registry
    }
  })
}
export function createComponentRegistry<T>(components: BuiltInComponents<T>): ComponentRegistry<T> {
  if (!components || typeof components !== 'object' || Array.isArray(components)) fail('components')
  const keys = Object.keys(components)
  if (keys.length !== COMPONENT_KINDS.length || keys.some(key => !COMPONENT_KINDS.includes(key as ComponentKind))) fail('built-in kinds')
  const builder = createComponentRegistryBuilder<T>()
  for (const kind of COMPONENT_KINDS) {
    if (!Object.prototype.hasOwnProperty.call(components, kind)) fail('missing component')
    builder.register(kind, components[kind])
  }
  return builder.build()
}
