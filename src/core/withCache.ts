import { AbortController, AbortSignal } from 'node-abort-controller'
import { debug } from './debug'

export type Cache<State = any> = {
  loading: Record<string, Promise<State>>
  loaders: Record<string, StateLoader<State>>
  loaded: Record<string, CacheEntry<State>>
}

/** The internal data structure used by `Cache` type */
export type CacheEntry<State = any> = [state: State, expiresAt?: number]

export type CacheControl = {
  /** The string used to identify this entry */
  readonly key: string
  /**
   * The last loaded value that is now expired.
   */
  oldValue?: any
  /**
   * Number of seconds until this entry is reloaded on next request.
   * Once expired, the loaded value remains in the cache until another
   * value is loaded.
   */
  maxAge: number
  /**
   * Set a timeout that aborts the loading of this entry unless its
   * promise resolves first.
   */
  setTimeout: (secs: number) => AbortSignal
}

type Promisable<T> = T | PromiseLike<T>
type StateLoader<State = any> = {
  (cacheControl: CacheControl): Promisable<State>
}

export function withCache<State = any>(
  cache: Cache<State>,
  getDefaultLoader: (cacheKey: string) => StateLoader<State>
): (cacheKey: string, loader?: StateLoader<State>) => Promise<State>

export function withCache<State = any>(
  cache: Cache<State>,
  getDefaultLoader?: (cacheKey: string) => StateLoader<State> | undefined
): {
  (cacheKey: string): Promise<State | undefined> | undefined
  (cacheKey: string, loader: StateLoader<State>): Promise<State>
}

export function withCache(
  cache: Cache,
  getDefaultLoader: (cacheKey: string) => StateLoader | undefined = () =>
    undefined
) {
  return function getCachedState(cacheKey: string, loader?: StateLoader) {
    const entry = cache.loaded[cacheKey]
    if (entry) {
      const expiresAt = entry[1] ?? Infinity
      if (expiresAt - Date.now() > 0) {
        return Promise.resolve(entry[0])
      }
    }

    const oldPromise = cache.loading[cacheKey] as Promise<any> | undefined
    if (oldPromise || !(loader ||= getDefaultLoader(cacheKey))) {
      return oldPromise
    }

    const promise = new Promise((resolve, reject) => {
      const entryConfig: CacheControl = {
        key: cacheKey,
        oldValue: entry?.[0],
        maxAge: Infinity,
        setTimeout: secs => {
          const ctrl = new AbortController()
          setTimeout(() => {
            if (promise == cache.loading[cacheKey]) {
              delete cache.loading[cacheKey]
            }
            ctrl.abort()
            reject(new Error('Timed out'))
          }, secs * 1e3)

          return ctrl.signal
        },
      }

      Promise.resolve(loader!(entryConfig)).then(
        state => {
          // Skip caching if the promise is replaced or deleted
          // before it resolves.
          if (promise == cache.loading[cacheKey]) {
            delete cache.loading[cacheKey]

            const { maxAge } = entryConfig
            if (maxAge > 0) {
              cache.loaded[cacheKey] = isFinite(maxAge)
                ? [state, Date.now() + maxAge * 1e3]
                : [state]
            } else {
              debug('State %s expired while loading, skipping cache', cacheKey)
            }
          }
          resolve(state)
        },
        error => {
          if (promise == cache.loading[cacheKey]) {
            delete cache.loading[cacheKey]
          }
          reject(error)
        }
      )
    })

    cache.loaders[cacheKey] = loader
    cache.loading[cacheKey] = promise
    return promise
  }
}
