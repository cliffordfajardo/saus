import callsites from 'callsites'
import { StackFrame } from './types'

export function getStackFrame(depth: number): StackFrame | undefined {
  const callStack = callsites().filter(callsite => {
    const fileName = callsite.getFileName()
    return !!fileName && !fileName.startsWith('node:')
  })
  const callsite = callStack[depth]
  if (!callsite) {
    return
  }
  const file = callsite.getFileName()
  if (!file) {
    return
  }
  const func = callsite.getFunctionName()
  const line = callsite.getLineNumber() || 1
  const column = callsite.getColumnNumber() || 1

  let source = file + (line ? ':' + line : '') + (column ? ':' + column : '')
  if (func) {
    source = `${func} (${source})`
  }

  return {
    text: `    at ${source}`,
    file,
    line,
    column,
  }
}
