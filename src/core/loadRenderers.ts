import { plural } from '../utils/plural'
import { createAsyncRequire } from '../vm/asyncRequire'
import { compileSsrModule } from '../vm/compileSsrModule'
import { dedupeNodeResolve } from '../vm/dedupeNodeResolve'
import { executeModule } from '../vm/executeModule'
import { formatAsyncStack } from '../vm/formatAsyncStack'
import { registerModuleOnceCompiled } from '../vm/moduleMap'
import { ModuleMap, RequireAsync, ResolveIdHook } from '../vm/types'
import { SausContext } from './context'
import { debug } from './debug'
import { setRenderModule } from './global'

type LoadOptions = {
  resolveId?: ResolveIdHook
}

export async function loadRenderers(
  context: SausContext,
  options: LoadOptions
) {
  const time = Date.now()
  const moduleMap = context.moduleMap || {}
  const { resolveId = () => undefined } = options
  const { dedupe } = context.config.resolve

  const ssrRequire = createAsyncRequire({
    moduleMap,
    resolveId,
    nodeResolve: dedupe && dedupeNodeResolve(context.root, dedupe),
    isCompiledModule: id =>
      !id.includes('/node_modules/') && id.startsWith(context.root + '/'),
    compileModule: (id, ssrRequire) =>
      compileSsrModule(id, context, ssrRequire),
  })

  context.compileCache.locked = true
  const renderModule =
    moduleMap[context.renderPath] ||
    (await compileRenderModule(context, ssrRequire, moduleMap))
  const renderConfig = setRenderModule({
    renderers: [],
    beforeRenderHooks: [],
  })
  try {
    await executeModule(renderModule)
    context.compileCache.locked = false
    Object.assign(context, renderConfig)
    const rendererCount =
      context.renderers.length + (context.defaultRenderer ? 1 : 0)
    debug(
      `Loaded ${plural(rendererCount, 'renderer')} in ${Date.now() - time}ms`
    )
  } catch (error: any) {
    formatAsyncStack(error, moduleMap, [], context.config.filterStack)
    throw error
  } finally {
    setRenderModule(null)
  }
}

function compileRenderModule(
  context: SausContext,
  ssrRequire: RequireAsync,
  moduleMap: ModuleMap
) {
  return registerModuleOnceCompiled(
    moduleMap,
    compileSsrModule(context.renderPath, context, ssrRequire).then(module => {
      if (!module) {
        throw Error(`Cannot find module '${context.renderPath}'`)
      }
      return module
    })
  )
}
