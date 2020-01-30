import * as param from '@jkcfg/std/param'
import * as std from '@jkcfg/std'

const config = param.all();
let output = [];

const numNodes = config => config.controlPlane.nodes + config.workers.nodes;

const backend = {
  docker: {
    image: 'quay.io/footloose/centos7:0.6.0',
    registryImage: 'chanwit/footloose-registry:2',
    // The below is required for dockerd to run smoothly.
    // See also: https://github.com/weaveworks/footloose#running-dockerd-in-container-machines
    privileged: true,
    volumes: [{
      type: 'volume',
      destination: '/var/lib/docker',
    }]
  },
  ignite: {
    image: 'weaveworks/ignite-centos:firekube-pre3',
    registryImage: 'chanwit/ignite-registry:2',
    privileged: false,
    volumes: [],
  },
};

const image = config => backend[config.backend].image;
const registryImage = config => backend[config.backend].registryImage;
const privileged = config => backend[config.backend].privileged;
const volumes = config => backend[config.backend].volumes;

const footloose = config => ({
  cluster: {
    name: 'firekube',
    privateKey: 'cluster-key',
  },
  machines: [
   {
      count: numNodes(config),
      spec: {
        image: image(config),
        name: 'node%d',
        backend: config.backend,
        ignite: {
          cpus: 4,
          memory: '12GB',
          diskSize: '40GB',
          kernel: 'weaveworks/ignite-kernel:4.19.47',
        },
        portMappings: [{
          containerPort: 22,
          hostPort: 2222,
        }, {
          containerPort: 6443,
          hostPort: 6443,
        }, {
          containerPort: 30443,
          hostPort: 30443,
        }, {
          containerPort: 30080,
          hostPort: 30080,
        }],
        privileged: privileged(config),
        volumes: volumes(config),
      },
    },
    {
      count: 1,
      spec: {
        image: registryImage(config),
        name: 'registry%d',
        backend: config.backend,
        ignite: {
          cpus: 1,
          memory: '2GB',
          diskSize: '40GB',
          kernel: 'weaveworks/ignite-kernel:4.19.47',
        },
        portMappings: [{
          containerPort: 22,
          hostPort: 2222,
        }, {
          containerPort: 5000,
          hostPort: 5000,
        }],
        privileged: privileged(config),
        volumes: volumes(config),
      }
    }
  ],
});

output.push({ path: 'footloose.yaml', value: footloose(config) });

// List is a Kubernetes list.
const List = items => ({
  apiVersion: "v1",
  kind: "List",
  items
});

// Machine returns a WKS machine description from a configuration object describing its public IP, private IP, id, and its role.
const Machine = ({ id, privateIP, sshPort, role }) => ({
  apiVersion: 'cluster.k8s.io/v1alpha1',
  kind: 'Machine',
  metadata: {
    labels: {
      set: role,
    },
    name: `${role}-${id}`,
    namespace: 'weavek8sops'
  },
  spec: {
    providerSpec: {
      value: {
        apiVersion: 'baremetalproviderspec/v1alpha1',
        kind: 'BareMetalMachineProviderSpec',
        public: {
          address: '127.0.0.1',
          port: sshPort,
        },
        private: {
          address: privateIP,
          port: 22,
        }
      }
    }
  }
});

const sshPort = machine => machine.ports.find(p => p.guest == 22).host;

if (config.machines !== undefined) {
  const machines = [];

  for (let i = 0; i < config.controlPlane.nodes; i++ ) {
    const machine = config.machines[i];
    machines.push(Machine({
      id: i,
      privateIP: machine.runtimeNetworks[0].ip,
      sshPort: sshPort(machine),
      role: 'master',
    }));
  }

  for (let i = 0; i < config.workers.nodes; i++ ) {
    const machine = config.machines[config.controlPlane.nodes + i];
    machines.push(Machine({
      id: i,
      privateIP: machine.runtimeNetworks[0].ip,
      sshPort: sshPort(machine),
      role: 'worker',
    }));
  }

  output.push({ path: 'machines.yaml', value: List(machines) });

  const registry = config.machines[config.machines.length - 1];
  const cluster = config => ({
    apiVersion: 'cluster.k8s.io/v1alpha1',
    kind: 'Cluster',
    metadata: {
      name: 'example'
    },
    spec: {
      clusterNetwork: {
        services: {
          cidrBlocks: ['10.96.0.0/12']
        },
        pods: {
          cidrBlocks: ['192.168.0.0/16']
        },
        serviceDomain: 'cluster.local'
      },
      providerSpec: {
        value: {
          apiVersion: 'baremetalproviderspec/v1alpha1',
          kind: 'BareMetalClusterProviderSpec',
          user: 'root',
          imageRepository: registry.runtimeNetworks[0].ip + ':5000',
          os: {
            files:[
            {
              source: {
                configmap: 'repo',
                key: 'kubernetes.repo'
              },
              destination: '/etc/yum.repos.d/kubernetes.repo'
            },
            {
              source: {
                configmap: 'repo',
                key: 'docker-ce.repo'
              },
              destination: '/etc/yum.repos.d/docker-ce.repo'
            },{
              source: {
                configmap: 'docker',
                key: 'daemon.json'
              },
              destination: '/etc/docker/daemon.json'
            }]
          },
          cri: {
            kind: 'docker',
            package: 'docker-ce',
            version: '18.09.7'
          }
        }
      }
    }
  });

  output.push({ path: 'cluster.yaml', value: cluster(config) });

}

export default output;
