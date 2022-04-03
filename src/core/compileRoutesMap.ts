import { warn } from 'misty'
import path from 'path'
import { babel, t } from '../babel'
import { SausContext } from './context'

export const routeMarker = '__sausRoute'

type ResolvedId = { id: string }

export async function compileRoutesMap(
  options: { isBuild?: boolean; isClient?: boolean },
  context: SausContext,
  resolveId: (id: string, importer: string) => Promise<ResolvedId | null>,
  clientRouteMap?: Record<string, string>
) {
  const unresolvedRoutes: [string, string][] = []
  for (const route of context.routes) {
    unresolvedRoutes.push([
      context.basePath + route.path.slice(1),
      route.moduleId,
    ])
  }
  if (context.defaultRoute) {
    unresolvedRoutes.push(['default', context.defaultRoute.moduleId])
  }

  const routePaths = new Set<string>()
  const resolvedRoutes: t.ObjectProperty[] = []

  await Promise.all(
    unresolvedRoutes.reverse().map(async ([routePath, routeModuleId]) => {
      // Protect against duplicate route paths.
      if (routePaths.has(routePath)) return
      routePaths.add(routePath)

      let resolvedId = clientRouteMap && clientRouteMap[routeModuleId]
      if (!resolvedId) {
        const resolved = await resolveId(routeModuleId, context.routesPath)
        if (!resolved) {
          return warn(`Failed to resolve route: "${routeModuleId}"`)
        }
        resolvedId = resolved.id
        if (clientRouteMap) {
          clientRouteMap[routeModuleId] = resolvedId
        }
      }

      let propertyValue: t.Expression
      if (options.isBuild) {
        // For the client-side route map, the resolved module path
        // must be mapped to the production chunk created by Rollup.
        // To do this, we use a placeholder `__sausRoute` call which
        // is replaced in the `generateBundle` plugin hook.
        if (options.isClient) {
          propertyValue = t.callExpression(t.identifier(routeMarker), [
            t.stringLiteral(resolvedId),
          ])
        }
        // For the server-side route map, the route is mapped to
        // a dev URL, since the SSR module system uses that.
        else {
          propertyValue = t.stringLiteral(
            '/' + path.relative(context.root, resolvedId)
          )
        }
      } else {
        // In dev mode, the route mapping points to a dev URL.
        propertyValue = t.stringLiteral(
          context.basePath +
            (resolvedId.startsWith(context.root + '/')
              ? resolvedId.slice(context.root.length + 1)
              : '@fs/' + resolvedId)
        )
      }

      resolvedRoutes.push(
        t.objectProperty(t.stringLiteral(routePath), propertyValue)
      )
    })
  )

  const transformer: babel.Visitor = {
    ObjectExpression(path) {
      path.node.properties.push(...resolvedRoutes)
    },
  }

  const result = babel.transformSync(`export default {}`, {
    plugins: [{ visitor: transformer }],
  }) as { code: string }

  return result
}
