import * as RegexParam from 'regexparam'
import { routesModule } from './core/global'
import type {
  GeneratedRouteConfig,
  InferRouteParams,
  Route,
  RouteConfig,
  RouteLoader,
} from './core/routes'
import { getStackFrame } from './utils/resolveStackTrace'

const importRE = /\b\(["']([^"']+)["']\)/
const parseDynamicImport = (fn: Function, path: string) => {
  try {
    return importRE.exec(fn.toString())![1]
  } catch (e: any) {
    throw Error(`Failed to parse "moduleId" for route: "${path}"\n` + e.message)
  }
}

/** Define the default route */
export function route(load: RouteLoader): void

/** Define a catch route */
export function route<Module extends object>(
  path: 'error',
  load: RouteLoader<Module>,
  config?: RouteConfig<Module, { error: any }>
): void

/** Define a route */
export function route<RoutePath extends string, Module extends object>(
  path: RoutePath,
  load: RouteLoader<Module>,
  config?: RouteConfig<Module, InferRouteParams<RoutePath>>
): void

/** @internal */
export function route(
  pathOrLoad: string | RouteLoader,
  maybeLoad?: RouteLoader<any>,
  config?: RouteConfig<any, any>
) {
  const path = typeof pathOrLoad == 'string' ? pathOrLoad : 'default'
  const load = maybeLoad || (pathOrLoad as RouteLoader)
  const moduleId = parseDynamicImport(load, path)

  const route = {
    path,
    load,
    moduleId,
    ...config,
  } as Route

  if (path[0] === '/') {
    Object.assign(route, RegexParam.parse(path))
    routesModule.routes.push(route)
  } else if (path === 'default') {
    routesModule.defaultRoute = route
  } else if (path === 'error') {
    routesModule.catchRoute = route
  }
}

/** Define a route */
export function generateRoute<RoutePath extends string, Module extends object>(
  path: RoutePath,
  {
    entry,
    ...config
  }: GeneratedRouteConfig<Module, InferRouteParams<RoutePath>>
): void {
  const importer = getStackFrame(2)?.file
  const ssrRequire = routesModule.ssrRequire!

  let moduleId: string
  let load: () => Promise<any>
  if (typeof entry == 'string') {
    moduleId = entry
    load = () => ssrRequire(entry, importer, true)
  } else {
    moduleId = parseDynamicImport(entry, path)
    load = entry
  }

  routesModule.routes.push({
    ...(config as RouteConfig),
    ...RegexParam.parse(path),
    path,
    load,
    moduleId,
    generated: true,
  })
}
