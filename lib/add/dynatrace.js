const cds = require('@sap/cds-dk')
const { readProject, merge, registries } = cds.add
const { srv4, mtxSidecar4, approuter } = registries.mta

module.exports = class extends cds.add.Plugin {

  async canRun() {
    const { hasMta, hasHelm, hasHelmUnifiedRuntime } = readProject()
    if ((hasHelmUnifiedRuntime || hasHelm) && !hasMta) throw `'cds add dynatrace' is not available for Kyma yet`
    return true
  }

  async run() {
    const project = readProject()
    project.kind = 'to-dynatrace'
    await merge(__dirname, 'package.json.hbs').into('package.json', { with: project })
  }

  async combine() {
    const project = readProject()
    const { hasMta, hasApprouter, isJava, hasMultitenancy, srvPath } = project

    if (hasMta) {
      const dynatrace = {
        in: 'resources',
        where: {
          type: 'org.cloudfoundry.managed-service',
          'parameters.service': 'dynatrace'
        }
      }
      const srv = srv4(srvPath)
      const additions = [srv, dynatrace]
      const relationships = [{
        insert: [dynatrace, 'name'],
        into: [srv, 'requires', 'name']
      }]
      if (hasMultitenancy) {
        const mtxSidecar = mtxSidecar4(isJava ? 'mtx/sidecar' : 'gen/mtx/sidecar')
        additions.push(mtxSidecar)
        relationships.push({
          insert: [dynatrace, 'name'],
          into: [mtxSidecar, 'requires', 'name']
        })
      }
      if (hasApprouter) {
        additions.push(approuter)
        relationships.push({
          insert: [dynatrace, 'name'],
          into: [approuter, 'requires', 'name']
        })
      }
      await merge(__dirname, 'mta-dynatrace.yaml.hbs').into('mta.yaml', {
        with: project, additions, relationships
      })
    }
  }
}
