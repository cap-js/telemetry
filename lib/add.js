const cds = require('@sap/cds-dk')
const { readProject, merge, registries } = cds.add
const { srv4, mtxSidecar4, approuter } = registries.mta

module.exports = class TelemetryTemplate extends cds.add.Plugin {
  static hasInProduction() {
    return true
  }

  async canRun() {
    const { hasMta, hasHelm, hasHelmUnifiedRuntime } = readProject()
    if ((hasHelmUnifiedRuntime || hasHelm) && !hasMta) throw `'cds add telemetry' is not available for Kyma yet`
    return true
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
      await merge(__dirname, 'add/mta.yaml.hbs').into('mta.yaml', {
        with: project, additions, relationships
      })
    }
  }
}
