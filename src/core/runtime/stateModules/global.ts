import { getStackFrame } from '@/node/stack'
import type { StateModule } from '../stateModules'

export const stateModulesById = new Map<string, StateModule>()
export const stateModulesByFile = new Map<string, Map<string, StateModule>>()

export function trackStateModule(module: StateModule) {
  const caller = getStackFrame(3)
  if (caller) {
    const modules = stateModulesByFile.get(caller.file) || new Map()
    stateModulesByFile.set(caller.file, modules)
    modules.set(module.id, module)
  }
  stateModulesById.set(module.id, module)
}
