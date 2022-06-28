import secrets from '../secrets'
import { Stack } from '../types'
import { describeStackEvents } from './describeStackEvents'
import { signedRequest } from './request'

export interface DescribedStack {
  id?: string
  outputs: Record<string, string | undefined>
}

interface DescribeOptions {
  /**
   * Wait for a specific action to complete.
   */
  action?: 'CREATE' | 'UPDATE' | 'DELETE' | 'ROLLBACK'
  /**
   * Wait until the current action is completed or failed.
   */
  when?: 'settled'
}

/** This only describes the first instance of the given stack. */
export async function describeStack(
  stack: Stack,
  opts: DescribeOptions = {},
  trace = Error()
): Promise<DescribedStack> {
  const describeStacks = signedRequest.action('DescribeStacks', {
    region: stack.region,
    creds: secrets,
  })
  const { stacks } = await describeStacks({ stackName: stack.name }).catch(
    (e: any) => {
      if (!/ does not exist$/.test(e.message)) {
        throw e
      }
      return {} as ReturnType<typeof describeStacks>
    }
  )
  if (stacks?.length) {
    const { stackId, outputs, stackStatus } = stacks[0]
    console.log('status:', stackStatus)
    if (opts.action || opts.when == 'settled') {
      const action = opts.action || ''
      if (stackStatus.includes(action + '_IN_PROGRESS')) {
        return new Promise(resolve => {
          setTimeout(() => {
            resolve(describeStack(stack, opts, trace))
          }, 20e3)
        })
      }
      if (action && !stackStatus.includes(action + '_COMPLETE')) {
        await throwStackFailure({ ...stack, id: stackId }, trace)
      }
    }
    return {
      id: stackId!,
      outputs: (outputs || []).reduce((outputs, { outputKey, outputValue }) => {
        if (outputKey) {
          outputs[outputKey] = outputValue
        }
        return outputs
      }, {} as StackOutputs),
    }
  }
  return {
    id: undefined,
    outputs: {},
  }
}

async function throwStackFailure(stack: Stack, trace: Error): Promise<void> {
  const events = await describeStackEvents(stack)
  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    const status = event.resourceStatus
    if (!status || status.includes('ROLLBACK')) {
      continue
    }
    if (status.endsWith('_FAILED')) {
      const reason = event.resourceStatusReason || ''
      if (reason == 'Resource creation cancelled') {
        continue
      }

      const message = `Failed to ${status.slice(0, -7).toLowerCase()} "${
        event.logicalResourceId || event.resourceType
      }" resource. ${reason}`

      throw Object.assign(trace, {
        ...event,
        region: stack.region,
        code: status,
        message,
      })
    }
    if (event.resourceType == 'AWS::CloudFormation::Stack') {
      return // No failures found.
    }
  }
}
