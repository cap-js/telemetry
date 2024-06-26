const cds = require('@sap/cds-dk')
const { readProject, merge, registries } = cds.add
const { srv4, mtxSidecar4, approuter } = registries.mta

module.exports = class extends cds.add.Plugin {

  options() {
    return {
      'build-code': {
        type: 'boolean',
        help: `Use 'build-code' service plan on MTA generation.`,
      }
    }
  }

  async canRun() {
    const { hasMta, hasHelm, hasHelmUnifiedRuntime } = readProject()
    if ((hasHelmUnifiedRuntime || hasHelm) && !hasMta) throw `'cds add cloud-logging' is not available for Kyma yet`
    return true
  }

  async run() {
    const project = readProject()
    project.kind = 'to-cloud-logging'
    await merge(__dirname, 'files/package.json.hbs').into('package.json', { with: project })
  }

  async combine() {
    const project = readProject()
    const { hasMta, hasApprouter, isJava, hasMultitenancy, srvPath } = project

    if (hasMta) {
      const cloudLogging = {
        in: 'resources',
        where: {
          type: 'org.cloudfoundry.managed-service',
          'parameters.service': 'cloud-logging'
        }
      }
      const srv = srv4(srvPath)
      const additions = [srv, cloudLogging]
      const relationships = [{
        insert: [cloudLogging, 'name'],
        into: [srv, 'requires', 'name']
      }]
      if (hasMultitenancy) {
        const mtxSidecar = mtxSidecar4(isJava ? 'mtx/sidecar' : 'gen/mtx/sidecar')
        additions.push(mtxSidecar)
        relationships.push({
          insert: [cloudLogging, 'name'],
          into: [mtxSidecar, 'requires', 'name']
        })
      }
      if (hasApprouter) {
        additions.push(approuter)
        relationships.push({
          insert: [cloudLogging, 'name'],
          into: [approuter, 'requires', 'name']
        })
      }

      project.cloudLoggingServicePlan = cds.cli.options['build-code'] ? 'build-code' : 'standard'
      await merge(__dirname, 'files/mta-cloud-logging.yaml.hbs').into('mta.yaml', {
        with: project, additions, relationships
      })
    }
  }
}
