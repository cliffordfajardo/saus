import * as CloudForm from 'cloudform-types'
import { ResourceBase } from 'cloudform-types'
import { addDeployHook, addDeployTarget, getDeployContext } from 'saus/core'
import { AttributeRef, ResourceRef, Stack, StackTemplate } from './types'

const hook = addDeployHook(() => import('./hook'))

/**
 * Declare a AWS CloudFormation stack.
 */
export function useCloudFormation(name: string, template: StackTemplate) {
  return addDeployTarget(hook, defineStack(name, template))
}

async function defineStack(
  name: string,
  template: StackTemplate<any>
): Promise<Stack> {
  const resources: Record<string, ResourceBase> = {}
  const makeRef: ResourceRef.Factory = (id, resource) => {
    resources[id] = resource

    const ref: ResourceRef = CloudForm.Fn.Ref(id) as any
    ref.get = attr => CloudForm.Fn.GetAtt(id, attr) as AttributeRef
    ref.dependsOn = (...deps) => {
      deps.forEach(dep => resource.dependsOn(dep.id))
      return ref
    }

    // Ignore these properties when diffing.
    return Object.defineProperties(ref, {
      id: { value: id },
      get: { value: ref.get },
      dependsOn: { value: ref.dependsOn },
    })
  }

  const { command } = getDeployContext()
  const outputs =
    command == 'deploy' ? await template(makeRef, CloudForm) : null

  return {
    name,
    resources,
    outputs,
  }
}
