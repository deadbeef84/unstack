import Docker from 'dockerode'

const stack = 'nxt'
const docker = new Docker()

const services = await docker.listServices({
  filters: { label: [`com.docker.stack.namespace=${stack}`] },
})

// const s = services.find((x) => x.Spec.Name === 'nxt_antmediaserver')
// console.dir(s.Spec, { depth: 10 })
// process.exit()

const networks = Object.fromEntries(
  await Promise.all(
    [
      ...new Set(
        services.flatMap((s) =>
          s.Spec.TaskTemplate.Networks.map((n) => n.Target)
        )
      ),
    ].map((id) =>
      docker
        .getNetwork(id)
        .inspect()
        .then((n) => [id, n])
    )
  )
)

// console.dir(networks, {depth: 10})
// process.exit()

function deployConfig(x) {
  return (
    x && {
      parallelism: x.Parallelism !== 1 ? x.Parallelism : undefined,
      delay: x.Delay,
      failure_action: x.FailureAction !== 'pause' ? x.FailureAction : undefined,
      monitor: x.Monitor != undefined ? `${x.Monitor}ns` : undefined,
      max_failure_ratio: x.MaxFailureRatio,
      order: x.Order !== 'stop-first' ? x.Order : undefined,
    }
  )
}

function resources(r) {
  return (
    r && {
      reservations: r.Reservations && {
        cpus: r.Reservations.NanoCPUs
          ? String(r.Reservations.NanoCPUs / 1e9)
          : undefined,
        memory: r.Reservations.MemoryBytes
          ? String(r.Reservations.MemoryBytes)
          : undefined,
      },
      limits: r.Limits && {
        cpus: r.Limits.NanoCPUs ? String(r.Limits.NanoCPUs / 1e9) : undefined,
        memory: r.Limits.MemoryBytes ? String(r.Limits.MemoryBytes) : undefined,
      },
    }
  )
}

function placement(p) {
  return (
    p && {
      constraints: p.Constraints,
    }
  )
}

console.log(
  JSON.stringify(
    {
      networks: Object.fromEntries(
        Object.entries(networks).map(([name, net]) => [
          net.Name.replace(`${stack}_`, '').replace('host', 'hostnet'),
          {
            ...(net.Driver === 'overlay' ? {
              driver: 'overlay',
              attachable: net.Attachable,
            } : net.Name === 'host' ? {
              name: 'host',
              external: true,
            } : {}),
          }
        ])
      ),
      volumes: Object.fromEntries(
        services.flatMap(
          (s) =>
            s.Spec.TaskTemplate.ContainerSpec.Mounts?.filter(
              (m) => m.Type === 'volume'
            ).map((m) => [
              m.Source.replace(`${stack}_`, ''),
              { name: m.Source },
            ]) ?? []
        )
      ),
      services: Object.fromEntries(
        services.map(({ Spec: s }) => [
          s.Name.slice(stack.length + 1),
          {
            image: s.Labels['com.docker.stack.image'],
            command: s.TaskTemplate.ContainerSpec.Args,
            environment: s.TaskTemplate.ContainerSpec.Env,
            init: s.TaskTemplate.ContainerSpec.Init,
            ports: s.EndpointSpec.Ports?.map((p) => ({
              mode: p.PublishMode,
              protocol: p.Protocol,
              target: p.TargetPort,
              published: p.PublishedPort,
            })),
            volumes: s.TaskTemplate.ContainerSpec.Mounts?.map((m) => ({
              type: m.Type,
              source:
                m.Type === 'volume'
                  ? m.Source.replace(`${stack}_`, '')
                  : m.Source,
              target: m.Target,
              read_only: m.ReadOnly,
              ...(m.Type === 'bind'
                ? { bind: { create_host_path: true } }
                : m.Type === 'volume'
                ? { volume: {} }
                : {}),
            })),
            cap_add: s.TaskTemplate.ContainerSpec.CapabilityAdd?.map((x) =>
              x.replace(/^CAP_/, '')
            ),
            dns: s.TaskTemplate.ContainerSpec.DNSConfig?.Nameservers,
            dns_search: s.TaskTemplate.ContainerSpec.DNSConfig?.Search,
            networks: s.TaskTemplate.Networks.map((n) =>
              networks[n.Target]?.Name.replace(`${stack}_`, '').replace('host', 'hostnet')
            ),
            //shm_size: s.TaskTemplate.ContainerSpec.Hostname,
            hostname: s.TaskTemplate.ContainerSpec.Hostname,
            deploy: {
              labels: {
                ...s.Labels,
                'com.docker.stack.namespace': undefined,
                'com.docker.stack.image': undefined,
              },
              ...(s.Mode.Replicated?.Replicas !== 1
                ? {
                    mode: s.Mode.Global ? 'global' : 'replicated',
                    replicas: s.Mode.Replicated?.Replicas,
                  }
                : {}),
              restart_policy: s.TaskTemplate.RestartPolicy && {
                condition: s.TaskTemplate.RestartPolicy.Condition,
                delay: s.TaskTemplate.RestartPolicy.Delay,
                max_attempts: s.TaskTemplate.RestartPolicy.MaxAttempts !== 0 ? s.TaskTemplate.RestartPolicy.MaxAttempts : undefined,
                window: s.TaskTemplate.RestartPolicy.Window,
              },
              update_config: deployConfig(s.UpdateConfig),
              rollback_config: deployConfig(s.RollbackConfig),
              endpoint_mode: s.EndpointSpec.Mode !== 'vip' ? s.EndpointSpec.Mode : undefined,
              resources: resources(s.TaskTemplate.Resources),
              placement: placement(s.TaskTemplate.Placement),
            },
          },
        ])
      ),
    },
    null,
    2
  )
)
