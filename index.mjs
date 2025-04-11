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

function updateConfig(u) {
  return (
    u && {
      parallelism: u.Parallelism,
    }
  )
}

function rollbackConfig(r) {
  return (
    r && {
      parallelism: r.Parallelism,
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
      volumes: Object.fromEntries(
        services.flatMap(
          (s) =>
            s.Spec.TaskTemplate.ContainerSpec.Mounts?.filter(
              (m) => m.Type === 'volume'
            ).map((m) => [m.Source, { name: m.Source }]) ?? []
        )
      ),
      services: Object.fromEntries(
        services.map(({ Spec: s }) => [
          s.Name.slice(stack.length + 1),
          {
            ports: s.Endpoint.Ports.map((p) => ({
              protocol: p.Protocol,
              target: p.TargetPort,
              published: p.PublishedPort,
            })),
            image: s.Labels['com.docker.stack.image'],
            command: s.TaskTemplate.ContainerSpec.Args,
            environment: s.TaskTemplate.ContainerSpec.Env,
            volumes: s.TaskTemplate.ContainerSpec.Mounts?.map((m) => ({
              type: m.Type,
              source: m.Source,
              target: m.Target,
            })),
            dns: s.TaskTemplate.ContainerSpec.DNSConfig?.Nameservers,
            dns_search: s.TaskTemplate.ContainerSpec.DNSConfig?.Search,
            networks: s.Spec.TaskTemplate.Networks.map((n) => networks[n.Target]?.Name),
            deploy: {
              labels: {
                ...s.Labels,
                'com.docker.stack.namespace': undefined,
                'com.docker.stack.image': undefined,
              },
              mode: s.Mode.Global ? 'global' : 'replicated',
              replicas: s.Mode.Replicated?.Replicas,
              update_config: updateConfig(s.UpdateConfig),
              rollback_config: rollbackConfig(s.RollbackConfig),
              endpoint_mode: s.EndpointSpec.Mode,
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
