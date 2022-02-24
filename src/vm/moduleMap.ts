import { noop } from '../utils/noop'
import { ImporterSet } from './ImporterSet'
import { CompiledModule, ModuleMap } from './types'

const moduleMaps = new WeakMap<CompiledModule, ModuleMap>()

export function registerModule(module: CompiledModule, moduleMap: ModuleMap) {
  if (moduleMaps.has(module)) {
    throw Error('Module is already registered')
  }
  moduleMaps.set(module, moduleMap)
  moduleMap[module.id] = module
}

export function registerModuleOnceCompiled(
  moduleMap: ModuleMap,
  modulePromise: Promise<CompiledModule>
) {
  const compileQueue = moduleMap.__compileQueue
  if (!compileQueue) {
    Object.defineProperty(moduleMap, '__compileQueue', {
      value: undefined,
      writable: true,
    })
  }

  moduleMap.__compileQueue = modulePromise
    .then(module => {
      registerModule(module, moduleMap)
      return compileQueue
    })
    .catch(noop)

  return modulePromise
}

/**
 * Remove the given module from its module map, then invalidate any modules
 * that depend on it (directly or through another module). All affected modules
 * are re-executed, but only the given module is re-compiled.
 */
export function purgeModule(
  module: CompiledModule,
  visited = new Set<string>(),
  onModule?: (module: CompiledModule) => void
) {
  if (!visited.has(module.id)) {
    visited.add(module.id)
    onModule?.(module)
    for (const importer of module.importers) {
      resetModuleAndImporters(importer, visited, onModule)
    }
    const moduleMap = moduleMaps.get(module)
    if (moduleMap) {
      moduleMaps.delete(module)
      delete moduleMap[module.id]
    }
  }
}

/**
 * Reset the given module and its importers.
 */
export function resetModuleAndImporters(
  module: CompiledModule,
  visited = new Set<string>(),
  onModule?: (module: CompiledModule) => void
) {
  if (!visited.has(module.id)) {
    visited.add(module.id)
    onModule?.(module)
    for (const importer of module.importers) {
      resetModuleAndImporters(importer, visited, onModule)
    }
    resetModule(module)
  }
}

export function resetModule(module: CompiledModule) {
  module.exports = undefined
  module.package?.delete(module)
  module.package = undefined
  for (const imported of module.imports) {
    imported.importers.delete(module)
  }
  module.imports.clear()
  module.importers = new ImporterSet()
}
