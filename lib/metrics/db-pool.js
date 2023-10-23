const cds = require('@sap/cds')
const LOG = cds.log('otel', { label: 'otel:metrics' })

// REVISIT: instanceof cds.DatabaseService doesn't work with @cap-js databases
const _kinds = new Set('sqlite', 'hana', 'postgres')

const _initialized = new Set()

function init(pools) {
  const { metrics, ValueType } = require('@opentelemetry/api')

  const meter = metrics.getMeter(`${cds.env.requires.otel.trace.name}-meter`)
  const borrowedPool = meter.createObservableGauge('db.pool.borrowed', {
    description: 'The amount of currently borrowed connections of the db pool',
    unit: 'each',
    valueType: ValueType.INT
  })
  const pendingPool = meter.createObservableGauge('db.pool.pending', {
    description: 'The amount of currently pending connections of the db pool',
    unit: 'each',
    valueType: ValueType.INT
  })
  const sizePool = meter.createObservableGauge('db.pool.size', {
    description: 'The size of the db pool',
    unit: 'each',
    valueType: ValueType.INT
  })
  const availablePool = meter.createObservableGauge('db.pool.available', {
    description: 'The amount of currently available connections in the db pool',
    unit: 'each',
    valueType: ValueType.INT
  })
  const maxPool = meter.createObservableGauge('db.pool.max', {
    description: 'The maximal size of the db pool',
    unit: 'each',
    valueType: ValueType.INT
  })
  const minPool = meter.createObservableGauge('db.pool.min', {
    description: 'The minimum size of the db pool',
    unit: 'each',
    valueType: ValueType.INT
  })

  borrowedPool.addCallback(result => {
    pools.forEach((pool, tenant) => {
      if (!pool) {
        LOG._warn && LOG.warn('Pool not defined for tenant', tenant)
        return
      }
      result.observe(pool.borrowed, { 'sap.tenancy.tenant_id': tenant })
    })
  })
  pendingPool.addCallback(result => {
    pools.forEach((pool, tenant) => {
      if (!pool) {
        LOG._warn && LOG.warn('Pool not defined for tenant', tenant)
        return
      }
      result.observe(pool.pending, { 'sap.tenancy.tenant_id': tenant })
    })
  })
  sizePool.addCallback(result => {
    pools.forEach((pool, tenant) => {
      if (!pool) {
        LOG._warn && LOG.warn('Pool not defined for tenant', tenant)
        return
      }
      result.observe(pool.size, { 'sap.tenancy.tenant_id': tenant })
    })
  })
  availablePool.addCallback(result => {
    pools.forEach((pool, tenant) => {
      if (!pool) {
        LOG._warn && LOG.warn('Pool not defined for tenant', tenant)
        return
      }
      result.observe(pool.available, { 'sap.tenancy.tenant_id': tenant })
    })
  })
  maxPool.addCallback(result => {
    pools.forEach((pool, tenant) => {
      if (!pool) {
        LOG._warn && LOG.warn('Pool not defined for tenant', tenant)
        return
      }
      result.observe(pool.max, { 'sap.tenancy.tenant_id': tenant })
    })
  })
  minPool.addCallback(result => {
    pools.forEach((pool, tenant) => {
      if (!pool) {
        LOG._warn && LOG.warn('Pool not defined for tenant', tenant)
        return
      }
      result.observe(pool.min, { 'sap.tenancy.tenant_id': tenant })
    })
  })
}

module.exports = () => {
  // REVISIT: should probably be cds.on('connect') with check if a database service
  cds.on('connect', function(srv) {
    if (!_kinds.has(srv.kind)) return

    if (_initialized.has(srv.name)) return
    _initialized.add(srv.name)

    let pools
    srv.after('BEGIN', async function (_, req) {
      if (!this.dbc._pool) return

      if (!pools) init(pools = new Map())
      if (!pools.has(req.tenant)) {
        LOG._debug && LOG.debug('Adding pool to map for tenant', req.tenant)
        pools.set(req.tenant, this.dbc._pool)
      }
    })
  })
}
