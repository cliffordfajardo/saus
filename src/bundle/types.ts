export interface RenderedPage {
  html: string
  modules: ClientModule[]
}

export interface ClientModule {
  id: string
  text: string
  imports?: string[]
  exports?: string[]
}

export declare function getModuleUrl(module: ClientModule): string

declare function renderPage(pageUrl: string): Promise<RenderedPage | null>

export default renderPage
