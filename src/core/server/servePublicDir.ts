import etag from 'etag'
import fs from 'fs'
import { gray } from 'kleur/colors'
import * as mime from 'mrmime'
import path from 'path'
import type { RuntimeConfig } from '../config'
import { connect } from './connect'
import { debug } from './debug'

export const servePublicDir = (
  config: RuntimeConfig,
  publicDir: string,
  ignore = /^$/
) =>
  async function servePublicFile(
    req: connect.Request,
    res: connect.Response,
    next: connect.NextFunction
  ) {
    const fileName = req.url.slice(config.base.length)
    if (ignore.test(fileName)) {
      return next()
    }
    try {
      const content = fs.readFileSync(path.join(publicDir, fileName))
      debug(gray('read'), req.url)
      res.writeHead(200, {
        ETag: etag(content, { weak: true }),
        'Content-Type': mime.lookup(req.url) || 'application/octet-stream',
      })
      res.write(content)
      res.end()
    } catch (e: any) {
      if (e.code == 'ENOENT') {
        return next()
      }
      throw e
    }
  }
