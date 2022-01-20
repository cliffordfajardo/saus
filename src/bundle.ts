import * as babel from '@babel/core'
import arrify from 'arrify'
import builtins from 'builtin-modules'
import fs from 'fs'
import kleur from 'kleur'
import md5Hex from 'md5-hex'
import { fatal, warnOnce } from 'misty'
import path from 'path'
import { getBabelConfig, MagicString, t } from './babel'
import { ClientImport, generateClientModules } from './bundle/clients'
import { clientDir, runtimeDir } from './bundle/constants'
import { createModuleProvider } from './bundle/moduleProvider'
import { resolveMapSources, SourceMap } from './bundle/sourceMap'
import {
  isolateRoutes,
  resolveRouteImports,
  RouteImports,
} from './bundle/ssrRoutes'
import type { ClientModuleMap } from './bundle/types'
import {
  ClientFunction,
  ClientFunctions,
  dataToEsm,
  endent,
  extractClientFunctions,
  SausBundleConfig,
  SausContext,
} from './core'
import type { RuntimeConfig } from './core/config'
import { loadContext } from './core/context'
import { vite } from './core/vite'
import { debugForbiddenImports } from './plugins/debug'
import { redirectModule } from './plugins/redirectModule'
import { renderPlugin } from './plugins/render'
import { routesPlugin } from './plugins/routes'
import { Profiling } from './profiling'
import { callPlugins } from './utils/callPlugins'
import { parseImports, serializeImports } from './utils/imports'

export interface BundleOptions {
  absoluteSources?: boolean
  entry?: string | null
  isBuild?: boolean
  format?: 'esm' | 'cjs'
  minify?: boolean
  mode?: string
  outFile?: string
  write?: boolean
}

export async function loadBundleContext(inlineConfig?: vite.UserConfig) {
  try {
    return await loadContext('build', inlineConfig, [renderPlugin])
  } catch (e: any) {
    if (e.message.startsWith('[saus]')) {
      fatal(e.message)
    }
    throw e
  }
}

export async function bundle(context: SausContext, options: BundleOptions) {
  const bundleConfig = { ...context.config.saus.bundle }
  const bundleFormat = options.format || bundleConfig.format || 'cjs'
  bundleConfig.format = bundleFormat

  let bundlePath = options.outFile ? path.resolve(options.outFile) : null!
  let bundleEntry =
    options.entry !== undefined ? options.entry : bundleConfig.entry

  const outDir = context.userConfig.build?.outDir || 'dist'
  if (bundleEntry) {
    bundlePath = path.resolve(
      context.root,
      bundleEntry
        .replace(/^(\.\/)?src\//, outDir + '/')
        .replace(/\.ts$/, bundleFormat == 'cjs' ? '.js' : '.mjs')
    )
    bundleEntry = path.resolve(context.root, bundleEntry)
  }

  const shouldWrite =
    options.write !== false && context.config.build.write !== false

  if (!bundlePath && shouldWrite) {
    throw Error(
      `[saus] The "outFile" option must be provided when ` +
        `"saus.bundle.entry" is not defined in your Vite config ` +
        `(and the "write" option is not false).`
    )
  }

  const { functions, functionImports, routeImports, runtimeConfig } =
    await prepareFunctions(context, options)

  Profiling.mark('generate client modules')
  const { moduleMap, clientRouteMap } = await generateClientModules(
    functions,
    functionImports,
    runtimeConfig,
    context,
    options
  )

  Profiling.mark('generate ssr bundle')
  const bundleDir = bundlePath ? path.dirname(bundlePath) : context.root
  const { code, map } = await generateSsrBundle(
    context,
    options,
    runtimeConfig,
    routeImports,
    functions,
    moduleMap,
    clientRouteMap,
    bundleEntry,
    bundleConfig,
    bundleFormat,
    bundleDir
  )

  if (map && options.absoluteSources) {
    resolveMapSources(map, bundleDir)
  }

  const bundle = {
    path: bundlePath,
    code,
    map: map as SourceMap | undefined,
  }

  if (shouldWrite) {
    await callPlugins(context.plugins, 'onWriteBundle', bundle)

    context.logger.info(
      kleur.bold('[saus]') +
        ` Saving bundle as ${kleur.green(relativeToCwd(bundle.path))}`
    )

    fs.mkdirSync(path.dirname(bundle.path), { recursive: true })
    if (bundle.map) {
      fs.writeFileSync(bundle.path + '.map', JSON.stringify(bundle.map))
      bundle.code +=
        '\n//# ' + 'sourceMappingURL=' + path.basename(bundle.path) + '.map'
    }
    fs.writeFileSync(bundle.path, bundle.code)

    if (!bundleConfig.entry) {
      fs.copyFileSync(
        path.resolve(__dirname, '../src/bundle/types.ts'),
        bundle.path.replace(/(\.[cm]js)?$/, '.d.ts')
      )
    }
  }

  return bundle
}

async function getBuildTransform(config: vite.ResolvedConfig) {
  const context = await vite.createTransformContext(config, false)
  return [vite.createTransformer(context), context] as const
}

async function prepareFunctions(context: SausContext, options: BundleOptions) {
  const { root, renderPath, config } = context

  Profiling.mark('parse render functions')
  const functions = extractClientFunctions(renderPath)
  Profiling.mark('transform render functions')

  const functionExt = path.extname(renderPath)
  const functionModules = createModuleProvider()
  const functionImports: { [stmt: string]: ClientImport } = {}

  const [transform, { pluginContainer }] = await getBuildTransform({
    ...config,
    plugins: [functionModules, ...config.plugins],
  })

  const babelConfig = getBabelConfig(renderPath)
  const parseFile = (code: string) =>
    babel.parseSync(code, babelConfig) as t.File
  const parseStmt = <T = t.Statement>(code: string) =>
    parseFile(code).program.body[0] as any as T

  const registerImport = async (code: string, node?: t.ImportDeclaration) => {
    if (functionImports[code]) return

    // Explicit imports have a Babel node parsed from the source file,
    // while implicit imports need their injected code to be parsed.
    const isImplicit = node == null

    if (!node) {
      node = parseStmt(code)!
      if (!t.isImportDeclaration(node)) {
        return warnOnce(`Expected an import declaration`)
      }
    }

    const id = node.source.value

    let resolvedId = (await pluginContainer.resolveId(id, renderPath))?.id
    if (!resolvedId) {
      return warnOnce(`Could not resolve "${id}"`)
    }

    const isRelativeImport = id[0] == '.'
    const inProjectRoot = resolvedId.startsWith(root + '/')

    if (isRelativeImport && !inProjectRoot) {
      return warnOnce(`Relative import "${id}" resolved outside project root`)
    }

    const isVirtual = id === resolvedId || resolvedId[0] === '\0'
    const resolved: ClientImport = {
      id,
      code,
      source: isVirtual
        ? resolvedId
        : inProjectRoot
        ? resolvedId.slice(root.length)
        : `/@fs/${resolvedId}`,
      isVirtual,
      isImplicit,
    }

    if (!isVirtual)
      resolved.code =
        code.slice(0, node.source.start! - node.start!) +
        `"${resolved.source}"` +
        code.slice(node.source.end! - node.start!)

    functionImports[code] = resolved
  }

  const transformFunction = async (fn: ClientFunction) => {
    const functionCode = [
      ...fn.referenced,
      `export default ` + fn.function,
    ].join('\n')

    const functionModule = functionModules.addModule({
      id: `function.${md5Hex(functionCode).slice(0, 8)}${functionExt}`,
      code: functionCode,
    })

    const transformResult = await transform(functionModule.id)
    if (transformResult?.code) {
      const [prelude, transformedFn] =
        transformResult.code.split('\nexport default ')

      const referenced: string[] = []
      for (const node of parseFile(prelude).program.body) {
        const code = prelude.slice(node.start!, node.end!)
        referenced.push(code)
        if (t.isImportDeclaration(node)) {
          await registerImport(code, node)
        }
      }

      fn.transformResult = {
        function: transformedFn.replace(/;\n?$/, ''),
        referenced,
      }
    }
  }

  const implicitImports = new Set<string>()

  // The `onHydrate` function is used by every shared client module.
  implicitImports.add(`import { onHydrate as $onHydrate } from "saus/client"`)

  // The `hydrate` function is used by every inlined client module.
  implicitImports.add(`import { hydrate } from "saus/client"`)

  // Renderer packages often import modules that help with hydrating the page.
  for (const { imports } of config.saus.clients || []) {
    serializeImports(imports).forEach(stmt => implicitImports.add(stmt))
  }

  const routeImports = await resolveRouteImports(context, pluginContainer)

  // Every route has a module imported by the inlined client module.
  for (const { url } of routeImports.values()) {
    implicitImports.add(`import * as routeModule from "${url}"`)
  }

  await Promise.all([
    ...Array.from(implicitImports, stmt => registerImport(stmt)),
    ...functions.beforeRender.map(transformFunction),
    ...functions.render.map(renderFn =>
      Promise.all([
        transformFunction(renderFn),
        renderFn.didRender && transformFunction(renderFn.didRender),
      ])
    ),
  ])

  await pluginContainer.close()

  const bundleConfig = config.saus.bundle || {}
  const outDir = path.resolve(config.root, config.build.outDir)

  const runtimeConfig: RuntimeConfig = {
    assetsDir: config.build.assetsDir,
    base: config.base,
    bundleType: bundleConfig.type || 'script',
    command: 'bundle',
    defaultPath: context.defaultPath,
    minify: options.minify == true,
    mode: config.mode,
    publicDir: path.relative(outDir, config.publicDir),
    renderConcurrency: config.saus.renderConcurrency,
    // Replaced by the `generateClientModules` function.
    stateCacheUrl: '',
  }

  // The functions are now transpiled to plain JavaScript.
  functions.filename = path.basename(
    functions.filename.replace(/\.[^.]+$/, '.js')
  )

  return {
    functions,
    functionImports,
    implicitImports,
    routeImports,
    runtimeConfig,
  }
}

async function generateSsrBundle(
  context: SausContext,
  options: BundleOptions,
  runtimeConfig: RuntimeConfig,
  routeImports: RouteImports,
  functions: ClientFunctions,
  moduleMap: ClientModuleMap,
  clientRouteMap: Record<string, string>,
  bundleEntry: string | null | undefined,
  bundleConfig: SausBundleConfig,
  bundleFormat: 'esm' | 'cjs',
  bundleDir: string
) {
  const modules = createModuleProvider()

  modules.addModule({
    id: path.join(runtimeDir, 'functions.ts'),
    code: serializeClientFunctions(functions),
  })

  modules.addModule({
    id: path.join(runtimeDir, 'modules.ts'),
    code: dataToEsm(moduleMap),
  })

  const runtimeConfigModule = modules.addModule({
    id: path.join(runtimeDir, 'config.ts'),
    code: dataToEsm(runtimeConfig),
  })

  const pluginImports = new Set<string>()
  for (const plugin of context.plugins) {
    if (plugin.fetchBundleImports) {
      const imports = await plugin.fetchBundleImports(modules)
      imports?.forEach(source => pluginImports.add(source))
    }
  }

  const entryId = '\0saus/main.js'
  const runtimeId = `/@fs/${path.join(runtimeDir, 'main.ts')}`
  modules.addModule({
    id: entryId,
    code: endent`
      ${serializeImports(Array.from(pluginImports))}
      import "${context.renderPath}"
      import "${context.routesPath}"

      export * from "${runtimeId}"
      export { default } from "${runtimeId}"
      export { default as config } from "${runtimeConfigModule.id}"
    `,
    moduleSideEffects: 'no-treeshake',
  })

  const redirectedModules: vite.PluginOption[] = [
    redirectModule('saus', path.join(runtimeDir, 'index.ts')),
    redirectModule('saus/core', path.join(runtimeDir, 'core.ts')),
    redirectModule('saus/bundle', entryId),
    redirectModule(
      path.resolve(__dirname, '../src/core/global.ts'),
      path.join(runtimeDir, 'global.ts')
    ),
    redirectModule(
      path.resolve(__dirname, '../src/core/constants.ts'),
      path.join(runtimeDir, 'constants.ts')
    ),
    redirectModule(
      path.join(clientDir, 'cache.ts'),
      path.join(runtimeDir, 'context.ts')
    ),
    redirectModule(
      path.join(clientDir, 'loadPageModule.ts'),
      path.join(runtimeDir, 'loadPageModule.ts')
    ),
  ]

  const bundleType = bundleConfig.type || 'script'

  // Avoid using Node built-ins for `get` function.
  if (bundleType == 'worker') {
    redirectedModules.push(
      redirectModule(
        path.resolve(__dirname, '../src/core/http.ts'),
        path.join(runtimeDir, 'http.ts')
      ),
      // Redirect the `debug` package to a stub module.
      !options.isBuild &&
        redirectModule('debug', path.join(runtimeDir, 'debug.ts'))
    )
  }

  const config = await context.resolveConfig('build', {
    plugins: [
      await isolateRoutes(routeImports, context),
      routesPlugin(context.config.saus, clientRouteMap),
      debugForbiddenImports([
        'vite',
        './src/core/index.ts',
        './src/core/context.ts',
      ]),
      modules,
      bundleEntry &&
      bundleType == 'script' &&
      !supportTopLevelAwait(bundleConfig)
        ? wrapAsyncInit()
        : null,
      redirectedModules,
      rewriteHttpImports(),
      // debugSymlinkResolver(),
    ],
    build: {
      write: false,
      target: bundleConfig.target || 'node14',
      minify: bundleConfig.minify == true,
      sourcemap: context.userConfig.build?.sourcemap ?? true,
      rollupOptions: {
        input: bundleEntry || entryId,
        output: {
          dir: bundleDir,
          format: bundleFormat,
        },
      },
    },
  })

  // Externalize Node built-ins only.
  config.ssr!.external = builtins as string[]

  const buildResult = (await vite.build(config)) as vite.ViteBuild
  return buildResult.output[0].output[0]
}

/**
 * The renderers from the `saus.render` module are transformed at build time
 * for client-side use, so the SSR bundle can serve them from memory as-is.
 *
 * This function prepares a manifest for piecing together a hydration script
 * based on which renderer is used for a given page.
 */
const serializeClientFunctions = (functions: ClientFunctions) =>
  dataToEsm({
    filename: functions.filename,
    beforeRender: functions.beforeRender.map(serializeClientFunction),
    render: functions.render.map(renderFn => ({
      ...serializeClientFunction(renderFn),
      didRender: renderFn.didRender
        ? serializeClientFunction(renderFn.didRender)
        : undefined,
    })),
  })

const serializeClientFunction = (func: ClientFunction) => ({
  start: func.start,
  route: func.route,
  ...func.transformResult,
})

function relativeToCwd(file: string) {
  file = path.relative(process.cwd(), file)
  return file.startsWith('../') ? file : './' + file
}

// Technically, top-level await is available since Node 14.8 but Esbuild
// complains when this feature is used with a "node14" target environment.
function supportTopLevelAwait(bundleConfig: SausBundleConfig = {}) {
  const target = bundleConfig.target || 'node14'
  return arrify(target).some(
    target => target.startsWith('node') && Number(target.slice(4)) >= 15
  )
}

/**
 * Wrap the entire SSR bundle with an async IIFE, so top-level await
 * is possible in Node 14 and under.
 */
function wrapAsyncInit(): vite.Plugin {
  return {
    name: 'saus:wrapAsyncInit',
    enforce: 'pre',
    renderChunk(code) {
      const editor = new MagicString(code)

      const lastImport = parseImports(code).pop()
      const lastImportEnd = lastImport?.end || 0
      const semiPrefix = code[lastImportEnd - 1] == ';' ? '' : ';'
      editor.appendRight(lastImportEnd, `\n${semiPrefix}(async () => {`)
      editor.append(`\n})()`)

      return {
        code: editor.toString(),
        map: editor.generateMap(),
      }
    },
  }
}

/**
 * Allow `import('https://foo.com/bar.js')` calls to work as expected.
 * Both JSON and JavaScript modules are supported.
 */
function rewriteHttpImports(): vite.Plugin {
  const modulesId = path.join(runtimeDir, 'modules.ts')

  return {
    name: 'saus:rewriteHttpImports',
    enforce: 'post',
    async transform(code, id) {
      if (id == modulesId || id.includes('/node_modules/')) {
        return
      }

      const dynamicImportRE = /\bimport\(\s*["']([^"']+)["']\s*\)/g

      let editor: MagicString | undefined
      let match: RegExpMatchArray | null
      while ((match = dynamicImportRE.exec(code))) {
        const resolved = await this.resolve(match[1], id)
        if (resolved && /^https?:\/\//.test(resolved.id)) {
          const index = match.index!
          editor ||= new MagicString(code)
          editor.overwrite(
            index,
            index + match[0].length,
            `httpImport("${resolved.id}")`
          )
        }
      }

      if (editor) {
        editor.prepend(
          `import { httpImport } from "/@fs/${path.resolve(
            runtimeDir,
            'httpImport.ts'
          )}"\n`
        )
        return {
          code: editor.toString(),
          map: editor.generateMap({ hires: true }),
        }
      }
    },
  }
}
