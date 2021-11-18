import type { ComponentType } from 'react'
import type { RouteParams as InferRouteParams } from 'regexparam'
import * as RegexParam from 'regexparam'
import { ParsedUrl } from '../utils/url'
import { routesModule } from './global'

export { RegexParam, InferRouteParams }

export interface RouteModule extends Record<string, any> {}

export type RouteLoader<T extends object = RouteModule> = () => Promise<T>

export type RouteParams = Record<string, string>

type HasOneKey<T> = [string & keyof T] extends infer Keys
  ? Keys extends [infer Key]
    ? Key extends any
      ? [string & keyof T] extends [Key]
        ? 1
        : 0
      : never
    : never
  : never

type StaticPageParams<Params extends object> = 1 extends HasOneKey<Params>
  ? string | number
  : readonly (string | number)[]

type InferRouteProps<T extends object> = T extends ComponentType<infer Props>
  ? Props
  : Record<string, any>

type Promisable<T> = T | PromiseLike<T>

export interface RouteConfig<
  Module extends object = RouteModule,
  Params extends object = RouteParams
> {
  /**
   * Define which pages should be statically generated by providing
   * their path params.
   */
  paths?: () => Promisable<readonly StaticPageParams<Params>[]>
  /**
   * Load the page state for this route.
   */
  state?: (
    pathParams: string[],
    searchParams: URLSearchParams
  ) => Promisable<InferRouteProps<Module>>
}

export interface ParsedRoute {
  pattern: RegExp
  keys: string[]
}

export interface Route extends RouteConfig, ParsedRoute {
  path: string
  load: RouteLoader
  moduleId: string
}

export function matchRoute(path: string, route: ParsedRoute) {
  return route.pattern
    .exec(path)
    ?.slice(1)
    .reduce((params: Record<string, string>, value, i) => {
      params[route.keys[i]] = value
      return params
    }, {})
}

/**
 * Values set by the "routes module" defined in `saus.yaml` with
 * the `routes` path property.
 */
export type RoutesModule = {
  /** Routes defined with the `route` function */
  routes: Route[]
  /** The route used when no route is matched */
  defaultRoute?: Route
}

const importRE = /\b__vite_ssr_dynamic_import__\(["']([^"']+)["']\)/
const parseDynamicImport = (fn: Function) => importRE.exec(fn.toString())![1]

/** Define a route */
export function route<RoutePath extends string, Module extends object>(
  path: RoutePath,
  load: RouteLoader<Module>,
  config?: RouteConfig<Module, InferRouteParams<RoutePath>>
): void

/** Define the default route */
export function route(load: RouteLoader): void

/** @internal */
export function route(
  pathOrLoad: string | RouteLoader,
  maybeLoad?: RouteLoader<any>,
  config?: RouteConfig<any, any>
) {
  const path = typeof pathOrLoad == 'string' ? pathOrLoad : 'default'
  const load = maybeLoad || (pathOrLoad as RouteLoader)
  const route = {
    path,
    load,
    moduleId: parseDynamicImport(load),
    ...config,
  } as Route

  if (path === 'default') {
    route.keys = []
    route.pattern = /./
    route.cacheKey = () => path
    routesModule.defaultRoute = route
  } else {
    Object.assign(route, RegexParam.parse(path))
    routesModule.routes.push(route)
  }
}
