import { URLSearchParams } from 'url';

declare type RenderedFile = {
    id: string;
    data: any;
    mime: string;
};
interface RenderedPage {
    id: string;
    html: string;
    modules: Set<ClientModule>;
    assets: Set<ClientModule>;
    files: RenderedFile[];
}
interface ClientModule {
    id: string;
    text: string;
    debugText?: string;
    imports?: string[];
    exports?: string[];
}
/**
 * For entry chunks, keys are import statements.
 * For vendor chunks, keys are generated file names.
 * For route chunks, keys are dev URLs.
 */
interface ClientModuleMap {
    [key: string]: ClientModule;
}
declare type RenderPageOptions = {
    renderStart?: (url: string) => void;
    renderFinish?: (url: string, error: Error | null, page?: RenderedPage | null) => void;
};

/**
 * Write an array of rendered pages to disk. Shared modules are deduplicated.
 *
 * Returns a map of file names to their size in kilobytes. This object can be
 * passed to the `printFiles` function.
 */
declare function writePages(pages: ReadonlyArray<RenderedPage | null>, outDir: string): Record<string, number>;
/**
 * Print a bunch of files kind of like Vite does.
 *
 * @param logger The object responsible for printing
 * @param files File names (relative to the `outDir`) mapped to their size in kilobytes
 * @param outDir The directory (relative to your project root) where all given files reside
 * @param sizeLimit Highlight files larger than the given number of kilobytes (default: `500`)
 */
declare function printFiles(logger: {
    info(arg: string): void;
}, files: Record<string, number>, outDir: string, chunkLimit?: number, debugBase?: string | undefined): void;

/**
 * If you want to cache modules in-memory and serve them, this function
 * will be helpful. It returns the URL pathname that your server should
 * respond to for each module.
 */
declare const getModuleUrl: (mod: ClientModule) => string;

declare const moduleMap: ClientModuleMap;

declare class ParsedUrl {
    readonly searchParams: URLSearchParams;
    readonly path: string;
    constructor(path: string, searchParams: URLSearchParams);
    get search(): string;
    toString(): string;
    startsWith(prefix: string): boolean;
    slice(start: number, end?: number): ParsedUrl;
}

declare function renderPage(pageUrl: string | ParsedUrl, { renderStart, renderFinish }?: RenderPageOptions): Promise<RenderedPage | null>;

declare function getKnownPaths(options?: {
    noDebug?: boolean;
}): Promise<string[]>;

declare function ssrImport<T = ModuleExports>(id: string, isRequire?: boolean): Promise<T>;
declare type Promisable<T> = T | PromiseLike<T>;
declare type ModuleExports = Record<string, any>;
declare type ModuleLoader<T = ModuleExports> = (exports: T, module?: {
    exports: T;
}) => Promisable<void>;
/** Define a SSR module with async loading capability */
declare const __d: <T = ModuleExports>(id: string, loader: ModuleLoader<T>) => ModuleLoader<T>;

export { renderPage as default, getKnownPaths, getModuleUrl, moduleMap, printFiles, __d as ssrDefine, ssrImport, writePages };
